"""Run after the adapter has constructed idata; prediction is deliberately separate."""

summary = az.summary(idata, var_names=var_names, round_to="none")
report = {
    "seconds": _nuts_compile_seconds + _nuts_result["sampling_seconds"],
    "compile_seconds": _nuts_compile_seconds,
    "sampling_seconds": _nuts_result["sampling_seconds"],
    "divergences": int(idata.sample_stats.diverging.sum()),
    "max_rhat": float(summary.r_hat.max()),
    "min_ess": float(summary.ess_bulk.min()),
    "min_tail_ess": float(summary.ess_tail.min()),
    "min_ess_per_second": float(summary.ess_bulk.min())
    / _nuts_result["sampling_seconds"],
    "seasonality": seasonality,
    "adstock_mean": idata.posterior.adstock_alpha.mean(
        dim=["chain", "draw"]
    ).values.tolist(),
    "logp_evaluations": _nuts_result["logp_evaluations"],
}
emit(type="diagnostics", **report)
