mmm.idata = idata
emit(type="phase", phase="Checking predictions against the observed data")
pred = mmm.sample_posterior_predictive(
    data.drop(columns="y"),
    combined=False,
    backend="numba",
    random_seed=43,
    progressbar=False,
)
y = pred["y"] * mmm.get_scales_as_xarray()["target_scale"]
q = y.quantile([0.05, 0.5, 0.95], dim=["chain", "draw"])
emit(
    type="prediction",
    dates=data.date_week.dt.strftime("%Y-%m-%d").tolist(),
    observed=data.y.tolist(),
    low=q.sel(quantile=0.05).values.tolist(),
    median=q.sel(quantile=0.5).values.tolist(),
    high=q.sel(quantile=0.95).values.tolist(),
)
emit(type="done", seconds=report["seconds"])
