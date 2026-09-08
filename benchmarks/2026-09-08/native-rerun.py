import sys, time, json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
from benchmarks.native import sample_native, compile_browser_model, to_inference_data, np
import pandas, arviz_stats, pymc_marketing.mmm
from pyarrow import ipc
source=(ROOT/'examples/mmm/model.py').read_text()
diagnostics=(ROOT/'examples/mmm/diagnostics.py').read_text()
library=ROOT/'adapter/target/release/libnuts_browser_adapter.dylib'
records=[]; preparations={}
def prepare():
    ns={'SEASONALITY':True,'DATA_PATH':str(ROOT/'examples/mmm/mmm_example.csv')}
    start=time.perf_counter();exec(source,ns)
    compiled=compile_browser_model(ns['model'],ns['var_names'])
    return ns,compiled,time.perf_counter()-start
for mode in ['cold','reused']:
    if mode=='reused':ns,compiled,preparations[mode]=prepare()
    for seed in [42,142,242,342,442]:
        start=time.perf_counter()
        if mode=='cold':ns,compiled,compile_seconds=prepare()
        else:compile_seconds=0
        result=sample_native(compiled,library,seed=seed,binary=True)
        ns.update(idata=to_inference_data(result),_nuts_result=result,_nuts_compile_seconds=compile_seconds)
        exec(diagnostics,ns)
        wall=time.perf_counter()-start
        assert len(result['traces'])==4
        for trace in result['traces']:
            table=ipc.open_stream(trace['bytes']).read_all();assert table.num_rows==500
            if trace['group']=='posterior':
                offset=0
                for var in compiled.expanded_layout:
                    a=np.asarray(table[var['name']].to_pylist()).reshape(500,var['size'])
                    np.testing.assert_allclose(a,result['expanded_samples'][trace['chain'],:,offset:offset+var['size']])
                    offset+=var['size']
        records.append(dict(mode=mode,seed=seed,wall_seconds=wall,**ns['report']))
        (Path(__file__).parent/'native.json').write_text(json.dumps({'platform':'native-arm64','preparation_wall_seconds':preparations,'runs':records},indent=2))
print('Complete',len(records),'fits',flush=True)
