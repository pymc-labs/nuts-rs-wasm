;; Actual WASM callback fixture, not a JavaScript stand-in or a Numba claim.
(module
  (import "runtime" "memory" (memory 1))
  (func (export "density") (param $x i32) (param $g i32) (result f64)
    (local $a f64) (local $b f64)
    local.get $x f64.load local.set $a
    local.get $x f64.load offset=8 local.set $b
    local.get $g local.get $a f64.neg f64.store
    local.get $g local.get $b f64.neg f64.store offset=8
    local.get $a local.get $a f64.mul
    local.get $b local.get $b f64.mul f64.add f64.const -0.5 f64.mul)
  (func (export "expand") (param $x i32) (param $out i32) (result i32)
    local.get $out local.get $x f64.load local.get $x f64.load f64.mul f64.store
    local.get $out local.get $x f64.load offset=8 f64.const 1 f64.add f64.store offset=8
    i32.const 0)
)
