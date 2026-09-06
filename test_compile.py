"""Run directly in an environment with PyMC/Numba; no nutpie import needed."""

import ctypes
import unittest

import numpy as np
import pymc as pm

from compile_model import compile_browser_model


class CompilerTests(unittest.TestCase):
    def test_transformed_model_and_frozen_data(self):
        with pm.Model() as model:
            observed = pm.Data("observed", np.array([0.3, 0.8, -0.1]))
            loc = pm.Normal("loc", initval=0.2)
            scale = pm.HalfNormal("scale", initval=1.1)
            pm.Normal("y", loc, scale, observed=observed)
        compiled = compile_browser_model(model)
        logp = model.compile_logp(mode="NUMBA")
        grad = model.compile_dlogp(mode="NUMBA")
        point = model.initial_point()
        pointer = ctypes.POINTER(ctypes.c_double)
        for shift in [0, -0.03, 0.05]:
            x = compiled.initial + shift
            value = compiled.callback.ctypes(
                x.ctypes.data_as(pointer), compiled.gradient.ctypes.data_as(pointer)
            )
            shifted = {k: v + shift for k, v in point.items()}
            np.testing.assert_allclose(value, logp(shifted), atol=1e-9)
            np.testing.assert_allclose(compiled.gradient, grad(shifted), atol=1e-9)
        observed.set_value(np.array([10.0, 20.0, 30.0]))
        frozen = compiled.callback.ctypes(
            x.ctypes.data_as(pointer), compiled.gradient.ctypes.data_as(pointer)
        )
        self.assertEqual(frozen, value)
        self.assertNotAlmostEqual(frozen, logp(shifted))

    def test_expansion_uses_model_transforms_and_deterministics(self):
        with pm.Model(coords={"category": ["a", "b", "c"]}) as model:
            scale = pm.HalfNormal("scale", initval=1.7)
            prob = pm.Beta("prob", 2, 3, initval=0.4)
            simplex = pm.Dirichlet(
                "simplex", np.ones(3), initval=[0.2, 0.3, 0.5], dims="category"
            )
            pm.Deterministic("derived", scale * prob + simplex, dims="category")
        compiled = compile_browser_model(model)
        pointer = ctypes.POINTER(ctypes.c_double)
        status = compiled.expand_callback.ctypes(
            compiled.initial.ctypes.data_as(pointer),
            compiled.expanded.ctypes.data_as(pointer),
        )
        self.assertEqual(status, 0)
        expected = [1.7, 0.4, 0.2, 0.3, 0.5, 0.88, 0.98, 1.18]
        np.testing.assert_allclose(compiled.expanded, expected, atol=1e-9)
        self.assertEqual(compiled.expanded_layout[-1]["dims"], ["category"])
        self.assertEqual(compiled.coords["category"], ["a", "b", "c"])
        self.assertEqual(len(compiled.initial), 4)
        self.assertEqual(len(compiled.expanded), 8)

    def test_initial_position_is_immutable_and_separate_from_callback_scratch(self):
        with pm.Model() as model:
            pm.Normal("x", initval=0.7)
        compiled = compile_browser_model(model)
        original = compiled.initial.copy()
        config = compiled.config()
        self.assertNotEqual(config["x_pointer"], compiled.initial.ctypes.data)
        compiled.scratch[:] = 12.0
        pointer = ctypes.POINTER(ctypes.c_double)
        compiled.callback.ctypes(
            compiled.scratch.ctypes.data_as(pointer),
            compiled.gradient.ctypes.data_as(pointer),
        )
        np.testing.assert_array_equal(compiled.initial, original)
        self.assertEqual(compiled.config()["initial"], original.tolist())
        with self.assertRaises(ValueError):
            compiled.initial[0] = 100.0

    def test_discrete_rejected(self):
        with pm.Model() as model:
            pm.Bernoulli("x", 0.5)
        with self.assertRaisesRegex(ValueError, "continuous"):
            compile_browser_model(model)


if __name__ == "__main__":
    unittest.main()
