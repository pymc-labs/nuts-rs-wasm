"""Summarize the dated rerun without changing historical September 6 records."""
import json, statistics
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
root=Path(__file__).resolve().parent
runs={p:json.loads((root/f'{p}.json').read_text())['runs'] for p in ['native','browser']}
metrics=['sampling_seconds','seconds','wall_seconds','min_ess_per_second','min_ess','max_rhat']
summary={p:{mode:{k:{'median':statistics.median(r[k] for r in rr if r['mode']==mode),'min':min(r[k] for r in rr if r['mode']==mode),'max':max(r[k] for r in rr if r['mode']==mode)} for k in metrics} for mode in ['cold','reused']} for p,rr in runs.items()}
(root/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':11,'axes.spines.top':False,'axes.spines.right':False})
fig,axes=plt.subplots(1,2,figsize=(10.5,3.5),layout='constrained')
for ax,metric,title in zip(axes,['sampling_seconds','seconds'],['Warmup + sampling + trace recording','Including fresh model compilation']):
 for y,(p,rr) in enumerate(runs.items()):
  values=[r[metric] for r in rr if r['mode']=='cold']
  color={'native':'#526576','browser':'#1257d5'}[p]
  ax.scatter(values,[y]*5,s=35,color=color,alpha=.55)
  ax.scatter([statistics.median(values)],[y],marker='D',s=75,color=color)
 ax.set_yticks([0,1],['Native','Browser']);ax.set_ylim(-.55,1.55);ax.set_xlim(left=0)
 ax.set_title(title);ax.set_xlabel('Seconds · lower is faster');ax.grid(axis='x',alpha=.15)
fig.savefig(root/'mmm-performance.svg');fig.savefig(root/'mmm-performance.png',dpi=160)

p=root/'mmm-performance.svg'
p.write_text('\n'.join(line.rstrip() for line in p.read_text().splitlines())+'\n')
