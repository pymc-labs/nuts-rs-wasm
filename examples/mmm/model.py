"""The same model source is used by the app, notebook and benchmarks."""

import json

import arviz_stats as az
import numpy as np
import pandas as pd
from pymc_marketing.mmm import MMM, GeometricAdstock, LogisticSaturation

seasonality = globals().get("SEASONALITY", True)
data = pd.read_csv(
    globals().get("DATA_PATH", "/mmm_example.csv"), parse_dates=["date_week"]
)
mmm = MMM(
    date_column="date_week",
    channel_columns=["x1", "x2"],
    control_columns=["event_1", "event_2", "t"],
    adstock=GeometricAdstock(l_max=8),
    saturation=LogisticSaturation(),
    yearly_seasonality=2 if seasonality else None,
)
mmm.build_model(data.drop(columns="y"), data.y)
model = mmm._get_sampling_model()
var_names = [
    "adstock_alpha",
    "saturation_lam",
    "saturation_beta",
    "gamma_control",
    "y_sigma",
    "intercept_contribution",
]
if seasonality:
    var_names.append("gamma_fourier")


def emit(**event):
    print("MMM_EVENT " + json.dumps(event), flush=True)
