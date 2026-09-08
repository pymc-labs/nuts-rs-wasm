"""A short Python notebook that runs its model through the same browser adapter."""

import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent
source = (root / "mmm/model.py").read_text().split("\n", 1)[1]


def md(text):
    return {"cell_type": "markdown", "metadata": {}, "source": text.splitlines(True)}


def code(text):
    return {
        "cell_type": "code",
        "metadata": {},
        "execution_count": None,
        "outputs": [],
        "source": text.splitlines(True),
    }


cells = [
    md("""# A marketing mix model, sampled in your browser

This notebook uses **nuts-rs-wasm**, exactly like the interactive demo. Python in this notebook only prepares the model source and displays the browser view. Numba compilation, Rust NUTS, parameter expansion and Arrow storage all run in that view, on your device.

The example has 179 weeks and two channels. Edit the model source or turn yearly seasonality off below, run the cells, and click **Start sampling**. The first run loads about 120 MB of runtime assets. A local Jupyter notebook needs only IPython; PyMC is supplied by the browser runtime.
"""),
    code('model_source = """' + source + '"""\n'),
    md("""## Run the model

Use the hosted demo origin below, or extract both release archives and serve their combined directory locally (`python -m http.server 8000`), then set `demo_url = "http://localhost:8000"`. The configured model is passed in a URL fragment, which is not sent in HTTP requests. Only run model code you trust.
"""),
    code("""from IPython.display import IFrame, display
from urllib.parse import quote
import json

demo_url = "https://pymc-labs.github.io/nuts-rs-wasm"
configuration = {
    "source": model_source,
    "seasonality": True,  # Change to False and rerun to compare.
    "options": {"chains": 2, "tune": 750, "draws": 500, "seed": 42},
}
url = demo_url + "/notebook.html#" + quote(json.dumps(configuration), safe="")
display(IFrame(url, width="100%", height=950))
"""),
    md("""## Keep the posterior

Download the four Arrow files from the completed run: one posterior and one sampler-statistics file per chain. The values are on the original parameter scale, including selected deterministics. The view reports R-hat, bulk/tail ESS and divergences. This two-chain run is a demonstration; increase the sampling budget and assess convergence before making decisions.

For local analysis with PyArrow installed:
```python
import pyarrow.ipc as ipc
posterior = ipc.open_stream("chain-1-posterior.arrow").read_all()
posterior.schema
```

[Adapter, build instructions and release assets](https://github.com/pymc-labs/nuts-rs-wasm)
"""),
]
for cell in cells:
    cell["id"] = hashlib.sha256("".join(cell["source"]).encode()).hexdigest()[:12]
(root / "marketing-mix-in-your-browser.ipynb").write_text(
    json.dumps(
        {
            "cells": cells,
            "metadata": {
                "kernelspec": {
                    "display_name": "Python 3",
                    "language": "python",
                    "name": "python3",
                },
                "language_info": {"name": "python", "version": "3.13"},
            },
            "nbformat": 4,
            "nbformat_minor": 5,
        },
        indent=2,
    )
    + "\n"
)
