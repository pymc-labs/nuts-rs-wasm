use arrow::{ipc::writer::StreamWriter, record_batch::RecordBatch};
use nuts_rs::{
    ArrowConfig, Chain, ChainStorage, CpuLogpFunc, CpuMath, CpuMathError, DiagNutsSettings,
    HasDims, ItemType, LogpError, Settings, StatsDims, Storable, StorageConfig, TraceStorage,
    Value,
};
use rand::{rngs::StdRng, SeedableRng};
use serde::Deserialize;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
};

thread_local! {
    static BINARY: Cell<bool> = const { Cell::new(false) };
    static RETAIN_UNCONSTRAINED: Cell<bool> = const { Cell::new(true) };
    static SAMPLES: RefCell<Vec<f64>> = RefCell::new(Vec::new());
    static EXPANDED: RefCell<Vec<f64>> = RefCell::new(Vec::new());
    static STATS: RefCell<Vec<f64>> = RefCell::new(Vec::new());
    static RESULT: RefCell<Vec<u8>> = RefCell::new(Vec::new());
    static CONFIG: RefCell<Vec<Variable>> = RefCell::new(Vec::new());
    static CALLBACK: Cell<usize> = const { Cell::new(0) };
    static EXPAND_CALLBACK: Cell<usize> = const { Cell::new(0) };
    static TRACE_CALLBACK: Cell<usize> = const { Cell::new(0) };
    static EVALUATIONS: Cell<u64> = const { Cell::new(0) };
}
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn model_logp(x: *const f64, g: *mut f64, n: usize) -> f64;
    fn model_expand(x: *const f64, out: *mut f64, n: usize) -> i32;
    fn report_progress(chain: u32, index: u32, tuning: u32);
    fn report_samples(chain: u32, start: u32, data: *const f64, draws: u32, n: usize);
    fn report_trace(chain: u32, kind: u32, data: *const u8, len: usize);
}
#[derive(Clone, Deserialize)]
struct Variable {
    name: String,
    size: usize,
    shape: Vec<usize>,
    dims: Vec<String>,
}
#[derive(Clone)]
struct Density {
    n: usize,
    variables: Vec<Variable>,
}
impl HasDims for Density {
    fn dim_sizes(&self) -> HashMap<String, u64> {
        self.variables
            .iter()
            .flat_map(|v| {
                v.dims
                    .iter()
                    .cloned()
                    .zip(v.shape.iter().map(|&x| x as u64))
            })
            .collect()
    }
}
struct Expanded(Vec<f64>);
impl Storable<Density> for Expanded {
    fn names(parent: &Density) -> Vec<&str> {
        parent.variables.iter().map(|v| v.name.as_str()).collect()
    }
    fn item_type(_: &Density, _: &str) -> ItemType {
        ItemType::F64
    }
    fn dims<'a>(parent: &'a Density, name: &str) -> Vec<&'a str> {
        parent
            .variables
            .iter()
            .find(|v| v.name == name)
            .unwrap()
            .dims
            .iter()
            .map(String::as_str)
            .collect()
    }
    fn get_all<'a>(&'a mut self, parent: &'a Density) -> Vec<(&'a str, Option<Value>)> {
        let mut offset = 0;
        parent
            .variables
            .iter()
            .map(|v| {
                let start = offset;
                offset += v.size;
                (
                    v.name.as_str(),
                    Some(Value::F64(self.0[start..offset].to_vec().into())),
                )
            })
            .collect()
    }
}
#[derive(Debug, thiserror::Error)]
#[error("Non-finite model log density or gradient")]
struct DensityError;
impl LogpError for DensityError {
    fn is_recoverable(&self) -> bool {
        true
    }
}
impl CpuLogpFunc for Density {
    type LogpError = DensityError;
    type FlowParameters = ();
    type ExpandedVector = Expanded;
    fn dim(&self) -> usize {
        self.n
    }
    fn logp(&mut self, x: &[f64], g: &mut [f64]) -> Result<f64, DensityError> {
        EVALUATIONS.with(|v| v.set(v.get() + 1));
        #[cfg(target_arch = "wasm32")]
        let lp = unsafe { model_logp(x.as_ptr(), g.as_mut_ptr(), self.n) };
        #[cfg(not(target_arch = "wasm32"))]
        let lp = CALLBACK.with(|p| unsafe {
            let f: extern "C" fn(*const f64, *mut f64) -> f64 = std::mem::transmute(p.get());
            f(x.as_ptr(), g.as_mut_ptr())
        });
        if lp.is_finite() && g.iter().all(|v| v.is_finite()) {
            Ok(lp)
        } else {
            Err(DensityError)
        }
    }
    fn expand_vector<R: rand::Rng + ?Sized>(
        &mut self,
        _: &mut R,
        x: &[f64],
    ) -> Result<Expanded, CpuMathError> {
        let mut out = vec![0.; self.variables.iter().map(|v| v.size).sum()];
        #[cfg(target_arch = "wasm32")]
        if unsafe { model_expand(x.as_ptr(), out.as_mut_ptr(), out.len()) } != 0 {
            return Err(CpuMathError::ExpandError("Model expansion failed".into()));
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            let pointer = EXPAND_CALLBACK.with(|p| p.get());
            if pointer != 0 {
                let f: extern "C" fn(*const f64, *mut f64) -> i32 =
                    unsafe { std::mem::transmute(pointer) };
                if f(x.as_ptr(), out.as_mut_ptr()) != 0 {
                    return Err(CpuMathError::ExpandError("Model expansion failed".into()));
                }
            } else if out.len() == x.len() {
                out.copy_from_slice(x);
            } else {
                return Err(CpuMathError::ExpandError(
                    "Set an expansion callback".into(),
                ));
            }
        }
        Ok(Expanded(out))
    }
}
fn ipc(batch: &RecordBatch) -> Result<Vec<u8>, String> {
    let mut data = Vec::new();
    {
        let mut writer =
            StreamWriter::try_new(&mut data, &batch.schema()).map_err(|e| e.to_string())?;
        writer.write(batch).map_err(|e| e.to_string())?;
        writer.finish().map_err(|e| e.to_string())?;
    }
    Ok(data)
}
#[no_mangle]
pub extern "C" fn set_callback(p: usize) {
    CALLBACK.with(|v| v.set(p));
}
#[no_mangle]
pub extern "C" fn set_expand_callback(p: usize) {
    EXPAND_CALLBACK.with(|v| v.set(p));
}
#[no_mangle]
pub extern "C" fn set_trace_callback(p: usize) {
    TRACE_CALLBACK.with(|v| v.set(p));
}
#[no_mangle]
pub extern "C" fn alloc_f64(n: usize) -> *mut f64 {
    Box::into_raw(vec![0.; n].into_boxed_slice()) as *mut f64
}
/// # Safety
/// p must originate from alloc_f64(n) and must not have been freed.
#[no_mangle]
pub unsafe extern "C" fn free_f64(p: *mut f64, n: usize) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(p, n)));
}
/// # Safety
/// p must address n readable bytes in this module's memory.
#[no_mangle]
pub unsafe extern "C" fn set_variables(p: *const u8, n: usize) -> i32 {
    match serde_json::from_slice::<Vec<Variable>>(std::slice::from_raw_parts(p, n)) {
        Ok(v)
            if !v.is_empty()
                && v.iter().all(|v| {
                    v.size == v.shape.iter().product::<usize>() && v.shape.len() == v.dims.len()
                }) =>
        {
            CONFIG.with(|c| *c.borrow_mut() = v);
            0
        }
        _ => 1,
    }
}
#[no_mangle]
pub extern "C" fn result_ptr() -> *const u8 {
    RESULT.with(|r| r.borrow().as_ptr())
}
#[no_mangle]
pub extern "C" fn result_len() -> usize {
    RESULT.with(|r| r.borrow().len())
}
/// Configure result storage. Defaults preserve the original native JSON API.
#[no_mangle]
pub extern "C" fn set_result_options(binary: u32, retain_unconstrained: u32) {
    BINARY.with(|v| v.set(binary != 0));
    RETAIN_UNCONSTRAINED.with(|v| v.set(retain_unconstrained != 0));
}
#[no_mangle]
pub extern "C" fn samples_ptr() -> *const f64 {
    SAMPLES.with(|v| v.borrow().as_ptr())
}
#[no_mangle]
pub extern "C" fn samples_len() -> usize {
    SAMPLES.with(|v| v.borrow().len())
}
#[no_mangle]
pub extern "C" fn expanded_ptr() -> *const f64 {
    EXPANDED.with(|v| v.borrow().as_ptr())
}
#[no_mangle]
pub extern "C" fn expanded_len() -> usize {
    EXPANDED.with(|v| v.borrow().len())
}
#[no_mangle]
pub extern "C" fn stats_ptr() -> *const f64 {
    STATS.with(|v| v.borrow().as_ptr())
}
#[no_mangle]
pub extern "C" fn stats_len() -> usize {
    STATS.with(|v| v.borrow().len())
}
/// # Safety
/// start addresses n live doubles; native callers must first set a valid callback.
#[no_mangle]
pub unsafe extern "C" fn run(
    n: usize,
    chains: u32,
    tune: u32,
    draws: u32,
    seed: u32,
    start: *const f64,
    target_accept: f64,
) -> i32 {
    SAMPLES.with(|v| v.borrow_mut().clear());
    EXPANDED.with(|v| v.borrow_mut().clear());
    STATS.with(|v| v.borrow_mut().clear());
    let binary = BINARY.with(Cell::get);
    let retain_unconstrained = RETAIN_UNCONSTRAINED.with(Cell::get);
    let initial = std::slice::from_raw_parts(start, n);
    let work = || -> Result<serde_json::Value, String> {
        if n == 0
            || chains == 0
            || tune == 0
            || draws == 0
            || tune.checked_add(draws).is_none()
            || !target_accept.is_finite()
            || target_accept <= 0.
            || target_accept >= 1.
        {
            return Err("Invalid sampler options".into());
        }
        if !initial.iter().all(|v| v.is_finite()) {
            return Err("Initial position must be finite".into());
        }
        #[cfg(not(target_arch = "wasm32"))]
        if CALLBACK.with(|v| v.get() == 0) {
            return Err("Set a model callback".into());
        }
        let variables = CONFIG.with(|c| c.borrow().clone());
        if variables.is_empty() {
            return Err("Set variable metadata before sampling".into());
        }
        let density = Density { n, variables };
        let ne: usize = density.variables.iter().map(|v| v.size).sum();
        let mut samples = Vec::new();
        let mut expanded_samples = Vec::new();
        let mut all_stats = Vec::new();
        let mut divergences = 0;
        let mut leapfrogs = 0u64;
        EVALUATIONS.with(|v| v.set(0));
        for c in 0..chains {
            let mut settings = DiagNutsSettings::default();
            settings.num_tune = tune.into();
            settings.num_draws = draws.into();
            settings.maxdepth = 10;
            settings.adapt_options.step_size_settings.target_accept = target_accept;
            let math = CpuMath::new(density.clone());
            let mut config = ArrowConfig::default();
            config.store_warmup = false;
            let storage = config
                .new_trace(&settings, &math)
                .map_err(|e| e.to_string())?;
            let mut trace = storage
                .initialize_trace_for_chain(c.into())
                .map_err(|e| e.to_string())?;
            let mut rng = StdRng::seed_from_u64(seed as u64 + c as u64);
            let mut sampler = settings.new_chain(c.into(), math, &mut rng);
            sampler.set_position(initial).map_err(|e| e.to_string())?;
            let mut chain = Vec::new();
            let mut expanded_chain = Vec::new();
            let mut stats = Vec::new();
            let mut batch = Vec::new();
            for i in 0..tune + draws {
                // The pinned GlobalStrategy marks draws 0..num_tune as tuning.
                // draw() still advances adaptation, RNG and the last statistics state.
                // This adapter's expansion is deterministic and never uses the RNG.
                // Deferring expanded_draw() also leaves the transformation statistics
                // cursor untouched, so the first retained row records its current ID.
                if i < tune {
                    let (_, p) = sampler.draw().map_err(|e| e.to_string())?;
                    debug_assert!(p.tuning);
                    leapfrogs += p.num_steps;
                    #[cfg(target_arch = "wasm32")]
                    if i % 10 == 0 {
                        report_progress(c, i, u32::from(p.tuning));
                    }
                    continue;
                }
                let (x, mut expanded, mut full_stats, p) =
                    sampler.expanded_draw().map_err(|e| e.to_string())?;
                leapfrogs += p.num_steps;
                let math = sampler.math();
                let dims = StatsDims::from(&*math);
                let values = expanded.get_all(&*math);
                let flat: Vec<f64> = values
                    .iter()
                    .flat_map(|(_, v)| match v {
                        Some(Value::F64(a)) => a.to_vec(),
                        _ => vec![],
                    })
                    .collect();
                trace
                    .record_sample(&settings, full_stats.get_all(&dims), values, &p)
                    .map_err(|e| e.to_string())?;
                if !p.tuning {
                    divergences += u32::from(p.diverging);
                    if binary {
                        if retain_unconstrained {
                            SAMPLES.with(|v| v.borrow_mut().extend_from_slice(&x));
                        }
                        EXPANDED.with(|v| v.borrow_mut().extend_from_slice(&flat));
                        STATS.with(|v| {
                            v.borrow_mut().extend_from_slice(&[
                                f64::from(p.diverging),
                                p.num_steps as f64,
                                p.step_size,
                            ])
                        });
                    } else {
                        if retain_unconstrained {
                            chain.push(x.to_vec());
                        }
                        expanded_chain.push(flat.clone());
                    }
                    batch.extend(flat);
                    if !binary {
                        stats.push(serde_json::json!({"diverging":p.diverging,"n_steps":p.num_steps,"step_size":p.step_size}));
                    }
                    if batch.len() / ne >= 10 || i + 1 == tune + draws {
                        #[cfg(target_arch = "wasm32")]
                        report_samples(
                            c,
                            (i - tune + 1) - (batch.len() / ne) as u32,
                            batch.as_ptr(),
                            (batch.len() / ne) as u32,
                            ne,
                        );
                        batch.clear();
                    }
                }
                #[cfg(target_arch = "wasm32")]
                if i % 10 == 0 || i + 1 == tune + draws {
                    report_progress(c, i, u32::from(p.tuning));
                }
            }
            let trace = trace.finalize().map_err(|e| e.to_string())?;
            for (kind, batch) in [&trace.posterior, &trace.sample_stats].iter().enumerate() {
                let bytes = ipc(batch)?;
                #[cfg(target_arch = "wasm32")]
                report_trace(c, kind as u32, bytes.as_ptr(), bytes.len());
                #[cfg(not(target_arch = "wasm32"))]
                TRACE_CALLBACK.with(|p| {
                    if p.get() != 0 {
                        let f: extern "C" fn(u32, u32, *const u8, usize) =
                            std::mem::transmute(p.get());
                        f(c, kind as u32, bytes.as_ptr(), bytes.len());
                    }
                });
            }
            samples.push(chain);
            expanded_samples.push(expanded_chain);
            all_stats.push(stats);
        }
        let mut result = serde_json::json!({"divergences":divergences,"leapfrog_steps":leapfrogs,"logp_evaluations":EVALUATIONS.with(|v|v.get())});
        if binary {
            result["shape"] = serde_json::json!([chains, draws, ne]);
            result["unconstrained_width"] = serde_json::json!(n);
        } else {
            if retain_unconstrained {
                result["samples"] = serde_json::json!(samples);
            }
            result["expanded_samples"] = serde_json::json!(expanded_samples);
            result["stats"] = serde_json::json!(all_stats);
        }
        Ok(result)
    };
    let (value, status) = match work() {
        Ok(v) => (v, 0),
        Err(e) => (serde_json::json!({"error":e}), 1),
    };
    RESULT.with(|r| *r.borrow_mut() = serde_json::to_vec(&value).unwrap());
    status
}
