"""Regenerate the article figure and summary from the five observed fits."""

import json
from pathlib import Path

import matplotlib
import numpy as np

matplotlib.use("Agg")
import matplotlib.pyplot as plt

root = Path(__file__).resolve().parent
runs = {
    k: json.loads((root / f"{k}.json").read_text())["runs"]
    for k in ["native", "browser"]
}
metrics = ["sampling_seconds", "seconds", "min_ess_per_second", "min_ess", "max_rhat"]
summary = {
    p: {
        k: {
            "median": float(np.median([r[k] for r in rr])),
            "min": min(r[k] for r in rr),
            "max": max(r[k] for r in rr),
        }
        for k in metrics
    }
    for p, rr in runs.items()
}
summary["method"] = {
    "repetitions": 5,
    "seeds": [42, 142, 242, 342, 442],
    "chains": 2,
    "tune": 750,
    "draws": 500,
    "target_accept": 0.9,
    "seasonality": True,
    "hardware": "MacBook Air M3",
    "imports": "preloaded",
    "compilation": "new model and callbacks every fit",
    "precision": "Different floating-point/adaptation trajectories; not a matched-precision comparison.",
}
(root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
plt.rcParams.update(
    {
        "font.family": "DejaVu Sans",
        "font.size": 11,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.spines.left": False,
    }
)
fig, axes = plt.subplots(1, 2, figsize=(10.5, 3.5), layout="constrained")
colors = {"native": "#526576", "browser": "#1257d5"}
for ax, metric, title, xlabel in zip(
    axes,
    ["sampling_seconds", "min_ess_per_second"],
    ["Warmup + sampling", "Effective samples per second"],
    ["Seconds · lower is faster", "Minimum bulk ESS / second · higher is better"],
):
    for y, (name, rr) in enumerate(runs.items()):
        x = [r[metric] for r in rr]
        median = np.median(x)
        ax.hlines(y, min(x), max(x), color=colors[name], linewidth=3, alpha=0.45)
        ax.scatter(
            x, y + np.linspace(-0.12, 0.12, 5), s=32, color=colors[name], zorder=3
        )
        ax.scatter(
            [median],
            [y],
            marker="D",
            s=70,
            color=colors[name],
            edgecolor="white",
            zorder=4,
        )
        ax.annotate(
            f"{median:.2f}" if metric == "sampling_seconds" else f"{median:.1f}",
            (max(x), y),
            xytext=(10, 0),
            textcoords="offset points",
            va="center",
            weight="bold",
            color=colors[name],
        )
    ax.set_yticks([0, 1], ["Native", "Browser"])
    ax.set_ylim(1.65, -0.65)
    ax.set_xlim(0, max(r[metric] for rr in runs.values() for r in rr) * 1.23)
    ax.set_title(title, loc="left", weight="bold", pad=15)
    ax.set_xlabel(xlabel, labelpad=12)
    ax.grid(axis="x", alpha=0.15)
    ax.tick_params(axis="y", length=0)
fig.suptitle(
    "The same MMM, Rust sampler, parameter expansion and Arrow storage",
    fontsize=14,
    weight="bold",
)
for suffix in ["svg", "png"]:
    fig.savefig(
        root / f"mmm-performance.{suffix}",
        dpi=180,
        facecolor="white",
        metadata={"Creator": "nuts-rs-wasm benchmark"} if suffix == "svg" else None,
    )
print(json.dumps(summary, indent=2))
