"""SPH pressure is a sampled material-volume mean, with mass density as validity."""

from copy import deepcopy

import numpy as np
import pytest

from caemble_catalog import open_catalog
from app.kernel.coordinator.contracts import validate_artifact_payload
from app.methods.particles.outputs import build_outputs as conservative_outputs
from app.solvers.sph.outputs import build_outputs


@pytest.mark.parametrize("scope", ["cumulative", "final"])
@pytest.mark.parametrize("length_unit,scale", [("m", 1), ("mm", 1000)])
def test_pressure_uses_current_volume_and_matches_density_cells(scope, length_unit, scale):
    with open_catalog() as catalog:
        descriptor = catalog.get_solver_manifest("sph", "1.1.0")["descriptor"]
    rotation = np.array([[0, -1, 0], [1, 0, 0], [0, 0, 1]])
    origin = np.array([1, 2, 3])
    geometry = {"origin": origin * scale, "size": np.array([4, 2, 1]) * scale,
                "rotation": rotation, "gridShape": [4, 2, 1], "lengthUnit": length_unit,
                "source": "experiment", "rootId": "probe"}
    local = np.array([[0, .25, .5], [.25, .25, .5], [1, .25, .5],
                      [2.5, 1.25, .5], [4, 2, 1], [4.1, .25, .5]])
    positions = origin + local @ rotation.T
    model = {"mass": np.array([2., 6., 3., 4., 5., 99.])}
    samples = {"positions": np.stack((positions, positions)), "velocity": np.zeros((2, 6, 3)),
               "density": np.array([[1., 2., 3., 4., 5., 6.], [2., 2., 1., 2., 1., 3.]]),
               "pressure": np.array([[10., 30., 0., -4., 7., 1e6], [20., 40., 0., -8., 14., 1e6]]),
               "times": np.array([0., .5])}
    config = {"outputs": [{"key": name, "methodId": f"sph.{name}", "boxGrid": geometry,
                           "parameters": {"scope": {"value": scope}}}
                          for name in ("pressure", "mass-density", "momentum-density", "velocity")]}
    original = deepcopy(samples)
    artifacts = build_outputs(config, descriptor, model, samples)
    pressure, density = artifacts["pressure"], artifacts["mass-density"]
    expected = np.zeros((4, 2, 1, 2, 1, 1, 1))
    # These weights differ from both particle-count and mass weighting.
    expected[0, 0, 0, :, 0, 0, 0] = [(2 * 10 + 3 * 30) / 5, (1 * 20 + 3 * 40) / 4]
    expected[2, 1, 0, :, 0, 0, 0] = [-4, -8]
    expected[3, 1, 0, :, 0, 0, 0] = [7, 14]
    if scope == "final":
        expected = expected[:, :, :, -1:]
    np.testing.assert_array_equal(pressure["value"], expected)
    assert density["value"][1, 0, 0].min() > 0  # A valid zero pressure.
    assert density["value"][0, 1, 0].max() == 0  # An empty zero pressure.
    assert np.all(pressure["value"][density["value"] == 0] == 0)
    np.testing.assert_array_equal(pressure["axes"][3]["ticks"], density["axes"][3]["ticks"])
    assert pressure["boxGrid"]["configuration"] == "current"
    assert pressure["boxGrid"]["weighting"] == "material-volume"
    data = next(item["data"] for item in descriptor["methods"]["outputs"] if item["methodId"] == "sph.pressure")
    validate_artifact_payload(pressure, data, "pressure")
    old = conservative_outputs({**config, "outputs": config["outputs"][1:]}, descriptor, model, samples)
    for name, value in old.items():
        np.testing.assert_array_equal(artifacts[name]["value"], value["value"])
    for name in samples:
        np.testing.assert_array_equal(samples[name], original[name])


def test_pressure_is_optional_and_rejects_unknown_scope():
    with open_catalog() as catalog:
        descriptor = catalog.get_solver_manifest("sph", "1.1.0")["descriptor"]
    assert build_outputs({}, descriptor, {}, {}) == {}
    with pytest.raises(ValueError, match="scope"):
        build_outputs({"outputs": [{"key": "p", "methodId": "sph.pressure",
                                    "parameters": {"scope": "latest-window"}}]}, descriptor, {}, {})
