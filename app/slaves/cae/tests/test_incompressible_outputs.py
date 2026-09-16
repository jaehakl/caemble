"""Finite-volume observations use actual tetrahedron/Box intersection volumes."""

import asyncio
from copy import deepcopy
from itertools import permutations
from types import SimpleNamespace

import numpy as np
import pytest

from caemble_catalog import open_catalog
from app.kernel.api import FieldValue
from app.kernel.coordinator.contracts import validate_artifact_payload
from app.kernel.resources import ArtifactStore, ResourceStore
from app.kernel.transport.recording import materialize_record_value
from app.kernel.transport.tensor import encode_recorded_data, encode_tensor
from app.methods.coupling.tetrahedral import TetrahedralBoxOverlap
from app.methods.fields.box_grid import BoxGrid
from app.solvers.incompressible_flow.outputs import build_outputs
from tests.test_catalog_examples import decode_tensor_tree


TETRAHEDRON = np.array([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]])


def observation(shape=(2, 2, 2), origin=(0, 0, 0), size=(1, 1, 1), rotation=None, unit="m"):
    return BoxGrid({"origin": list(origin), "size": list(size), "gridShape": list(shape),
                    "rotation": np.eye(3) if rotation is None else rotation,
                    "lengthUnit": unit, "source": "experiment", "rootId": "probe"})


def output_problem(grid, pressure=(0., -4.)):
    with open_catalog() as catalog:
        descriptor = catalog.get_solver_manifest("incompressible-flow", "3.0.0")["descriptor"]
    descriptor["visualizations"].pop("traction")  # These tests isolate volume projection.
    points = np.concatenate((TETRAHEDRON, TETRAHEDRON * .5 + [1., 0., 0.]))
    cells = np.arange(8).reshape(2, 4)
    domain = SimpleNamespace(mesh=SimpleNamespace(points=points, cells=cells), density=960.,
                             identity="two-fluid-cells", metadata={"pressureReference": "volume-mean-zero",
                                 "pressureReferencePoint": [0., 0., 0.],
                                 "hydrostaticGravity": [0., 0., 0.], "drivingAcceleration": [0., 0., 0.]})
    solution = SimpleNamespace(pressure=np.asarray(pressure), velocity=np.array([[1., 2., 3.], [-3., 1., 4.]]),
                               face_volume_flux=np.array([1., -1., 0.]), iterations=2)
    config = {"outputs": [{"key": key, "methodId": "flow." + name, "boxGrid": grid.geometry}
                           for key, name in (("pressure", "pressure"), ("velocity", "velocity"), ("density", "mass-density"))]}
    return SimpleNamespace(config=config, descriptor=descriptor, cancellation=None), domain, solution


def test_tetrahedral_overlap_recovers_exact_partial_cell_volumes():
    mapping = TetrahedralBoxOverlap.prepare(TETRAHEDRON, [[0, 1, 2, 3]], observation())
    expected = np.zeros((2, 2, 2))
    expected[0, 0, 0] = 5 / 48
    expected[1, 0, 0] = expected[0, 1, 0] = expected[0, 0, 1] = 1 / 48
    np.testing.assert_allclose(mapping.fluid_volumes, expected, rtol=1e-14, atol=1e-16)
    assert mapping.fluid_volumes.sum() == pytest.approx(1 / 6, rel=1e-14)
    assert mapping.box_cell_volume == .125
    constant = mapping.average(np.array([-7.]))
    np.testing.assert_allclose(constant[expected > 0], -7.)
    np.testing.assert_array_equal(constant[expected == 0], 0.)


@pytest.mark.parametrize("unit,scale", [("m", 1.), ("mm", 1000.)])
def test_rotated_box_units_and_vertex_order_preserve_exact_volume(unit, scale):
    angle = .43
    rotation = np.array([[np.cos(angle), -np.sin(angle), 0.], [np.sin(angle), np.cos(angle), 0.], [0., 0., 1.]])
    origin = np.array([1.3, -2.4, .7])
    points = TETRAHEDRON @ rotation.T + origin
    grid = observation(shape=(3, 3, 3), origin=origin * scale, size=np.ones(3) * scale, rotation=rotation, unit=unit)
    baseline = TetrahedralBoxOverlap.prepare(points, [[0, 1, 2, 3]], grid)
    assert baseline.fluid_volumes.sum() == pytest.approx(1 / 6, rel=1e-13)
    for order in permutations(range(4)):
        actual = TetrahedralBoxOverlap.prepare(points, [list(order)], grid)
        np.testing.assert_allclose(actual.fluid_volumes, baseline.fluid_volumes, rtol=1e-12, atol=1e-15)


def test_tiny_intersection_without_centroid_nodes_or_interior_probe_center():
    epsilon = 1e-5
    grid = observation(shape=(1, 1, 1), origin=(1 - 2 * epsilon, epsilon / 2, epsilon / 2), size=(2 * epsilon,) * 3)
    assert not grid.contains(TETRAHEDRON).any()
    assert not grid.contains(TETRAHEDRON.mean(axis=0))
    assert grid.points().sum() > 1
    mapping = TetrahedralBoxOverlap.prepare(TETRAHEDRON, [[0, 1, 2, 3]], grid)
    assert mapping.fluid_volumes.item() == pytest.approx(epsilon ** 3 / 6, rel=2e-10)
    assert mapping.average(np.array([-3.])).item() == pytest.approx(-3.)


def test_box_inside_tetrahedron_and_empty_boxes():
    interior = observation(origin=(.1, .1, .1), size=(.1, .1, .1), shape=(2, 3, 4))
    mapping = TetrahedralBoxOverlap.prepare(TETRAHEDRON, [[0, 1, 2, 3]], interior)
    np.testing.assert_allclose(mapping.fluid_volumes, mapping.box_cell_volume, rtol=1e-13)
    empty = TetrahedralBoxOverlap.prepare(TETRAHEDRON, [[0, 1, 2, 3]], observation(origin=(2., 0., 0.)))
    assert empty.volumes.nnz == 0
    np.testing.assert_array_equal(empty.average(np.array([[1., 2., 3.]])), np.zeros((2, 2, 2, 3)))


def test_overlap_is_cancellable_while_visiting_a_large_tetrahedron():
    class Cancellation:
        def __init__(self):
            self.calls = 0

        def raise_if_cancelled(self):
            self.calls += 1
            if self.calls == 3:
                raise asyncio.CancelledError

    cancellation = Cancellation()
    with pytest.raises(asyncio.CancelledError):
        TetrahedralBoxOverlap.prepare(TETRAHEDRON * 4, [[0, 1, 2, 3]], observation(shape=(8, 8, 8)), cancellation)
    assert cancellation.calls == 3


def test_pressure_velocity_and_density_share_overlap_and_preserve_metadata(monkeypatch):
    grid = observation(shape=(4, 1, 1), size=(4, 1, 1))
    invocation, domain, solution = output_problem(grid)
    original = deepcopy(vars(solution))
    prepare, calls = TetrahedralBoxOverlap.prepare, []

    def counted(*args, **kwargs):
        calls.append(1)
        return prepare(*args, **kwargs)

    monkeypatch.setattr(TetrahedralBoxOverlap, "prepare", counted)
    artifacts, exports, visuals = build_outputs(invocation, domain, solution)
    assert len(calls) == 1
    assert set(artifacts) == {"pressure", "velocity", "density"}
    np.testing.assert_allclose(artifacts["pressure"]["value"].ravel(), [0., -4., 0., 0.])
    np.testing.assert_allclose(artifacts["density"]["value"].ravel(), [160., 20., 0., 0.])
    expected_velocity = np.concatenate((solution.velocity, np.zeros((2, 3))))
    np.testing.assert_allclose(artifacts["velocity"]["value"].reshape(4, 3), expected_velocity)
    assert np.any((artifacts["density"]["value"] > 0) & (artifacts["pressure"]["value"] == 0))
    for output in invocation.config["outputs"]:
        artifact = artifacts[output["key"]]
        data = next(item["data"] for item in invocation.descriptor["methods"]["outputs"] if item["methodId"] == output["methodId"])
        validate_artifact_payload(artifact, data, output["key"])
        assert artifact["value"].ndim == 7
        np.testing.assert_array_equal(artifact["axes"][3]["ticks"], [0.])
        np.testing.assert_array_equal(artifact["axes"][4]["ticks"], [0.])
        assert artifact["boxGrid"]["configuration"] == "current"
        assert artifact["boxGrid"].get("weighting") == (None if output["key"] == "density" else "material-volume")
    assert set(visuals) == {"pressure", "velocity"}
    assert visuals["pressure"].domain is visuals["velocity"].domain
    assert visuals["pressure"].metadata["pressureKind"] == "gauge"
    assert visuals["pressure"].metadata["pressureReference"] == "volume-mean-zero"
    assert visuals["velocity"].components == ("x", "y", "z")
    for name, field in visuals.items():
        assert isinstance(field, FieldValue) and field.location == "cell"
        validate_artifact_payload(field, invocation.descriptor["visualizations"][name]["data"], name)
        np.testing.assert_array_equal(field.values[:, 0], getattr(solution, name))
        assert field.metadata["sampleAxes"] == [{"axis": 1, "name": "time", "unit": "s", "ticks": [0.]}]
    for name, value in original.items():
        np.testing.assert_array_equal(getattr(solution, name), value)


def test_weighted_output_means_differ_from_full_box_density_and_ignore_observation_settings():
    invocation, domain, solution = output_problem(observation(shape=(1, 1, 1), size=(2, 1, 1)), pressure=(-2., 6.))
    artifacts, exports, visuals = build_outputs(invocation, domain, solution)
    assert artifacts["pressure"]["value"].item() == pytest.approx(-10 / 9)
    np.testing.assert_allclose(artifacts["velocity"]["value"].ravel(), (8 * solution.velocity[0] + solution.velocity[1]) / 9)
    assert artifacts["density"]["value"].item() == pytest.approx(90.)
    original = deepcopy(vars(solution))
    changed = deepcopy(invocation)
    for output in changed.config["outputs"]:
        output["boxGrid"] = observation(shape=(8, 4, 3), origin=(-.1, -.1, -.1), size=(2., 1.4, 1.4)).geometry
    finer, exports, native = build_outputs(changed, domain, solution)
    cell_volume = np.prod([2., 1.4, 1.4]) / (8 * 4 * 3)
    assert finer["density"]["value"].sum() * cell_volume == pytest.approx(180., rel=1e-13)
    for name in visuals:
        np.testing.assert_array_equal(native[name].values, visuals[name].values)
    for name, value in original.items():
        np.testing.assert_array_equal(getattr(solution, name), value)
    changed.config["outputs"] = []
    empty, exports, native = build_outputs(changed, domain, solution)
    assert empty == {} and set(native) == {"pressure", "velocity"}


@pytest.mark.parametrize("count", [2, 9000])
def test_pressure_transport_preserves_overlap_profile_inline_and_attachment(count):
    invocation, domain, solution = output_problem(observation(shape=(count, 1, 1), size=(count, 1, 1)))
    invocation.config["outputs"] = invocation.config["outputs"][:1]
    artifact = build_outputs(invocation, domain, solution)[0]["pressure"]
    definition = next(item["data"] for item in invocation.descriptor["methods"]["outputs"] if item["methodId"] == "flow.pressure")
    encoded, attachments, _ = encode_tensor("pressure", definition, artifact, 1)
    for name in ("configuration", "weighting", "sampling", "gridShape", "lengthUnit"):
        assert encoded["boxGrid"][name] == artifact["boxGrid"][name]
    assert bool(attachments) == (count == 9000)


def test_time_history_scopes_share_mapping_and_native_uses_actual_window_end(monkeypatch):
    invocation, domain, solution = output_problem(observation(shape=(2, 1, 1), size=(2, 1, 1)))
    samples = {"times": np.array([0., .02, .035]),
               "pressure": np.array([[2., 4.], [-3., 1.], solution.pressure]),
               "velocity": np.array([solution.velocity * 0, solution.velocity / 2, solution.velocity])}
    original = deepcopy(samples)
    final = deepcopy(invocation.config["outputs"][0])
    final.update(key="finalPressure", parameters={"scope": {"value": "final"}})
    invocation.config["outputs"].append(final)
    prepare, calls = TetrahedralBoxOverlap.prepare, []

    def counted(*args, **kwargs):
        calls.append(1)
        return prepare(*args, **kwargs)

    monkeypatch.setattr(TetrahedralBoxOverlap, "prepare", counted)
    artifacts, exports, visuals = build_outputs(invocation, domain, solution, samples=samples, time=.035)
    assert len(calls) == 1
    for name in ("pressure", "velocity", "density"):
        np.testing.assert_array_equal(artifacts[name]["axes"][3]["ticks"], samples["times"])
    np.testing.assert_array_equal(artifacts["pressure"]["value"][:, 0, 0, :, 0, 0, 0], samples["pressure"].T)
    np.testing.assert_array_equal(artifacts["velocity"]["value"][:, 0, 0, :, 0, 0], samples["velocity"].swapaxes(0, 1))
    np.testing.assert_allclose(artifacts["density"]["value"][:, 0, 0, :, 0, 0, 0], [[160.] * 3, [20.] * 3])
    np.testing.assert_array_equal(artifacts["finalPressure"]["axes"][3]["ticks"], [.035])
    np.testing.assert_array_equal(artifacts["finalPressure"]["value"].ravel(), solution.pressure)
    for name, field in visuals.items():
        np.testing.assert_array_equal(field.values[:, 0], getattr(solution, name))
        assert field.metadata["sampleAxes"][0]["ticks"] == [.035]
    for name in samples:
        np.testing.assert_array_equal(samples[name], original[name])
    invocation.config["outputs"][0]["parameters"] = {"scope": {"value": "invalid"}}
    with pytest.raises(ValueError, match="scope"):
        build_outputs(invocation, domain, solution, samples=samples, time=.035)


@pytest.mark.parametrize("attached", [False, True])
def test_native_snapshot_recording_retains_actual_time_and_vector_components(monkeypatch, attached):
    if attached:
        monkeypatch.setattr("app.kernel.transport.tensor.INLINE_LIMIT_BYTES", 8)
    invocation, domain, solution = output_problem(observation())
    invocation.config["outputs"] = []
    visuals = build_outputs(invocation, domain, solution, time=.0375)[2]
    resources = ResourceStore()
    artifacts, leases = ArtifactStore(resources), []
    try:
        for name, field in visuals.items():
            data = invocation.descriptor["visualizations"][name]["data"]
            validate_artifact_payload(field, data, name)
            schema = {"values": {key: value for key, value in data.items() if key not in {"metadata", "mesh"}},
                      "metadata": {name: {"dtype": member["dtype"], **({"axes": [{} for _ in member["shape"]]}
                                    if member.get("shape") else {})} for name, member in data["metadata"].items()},
                      "location": {"dtype": "string"}, "domain": {
                "identity": {"dtype": "string"}, "points": {"dtype": "float64", "axes": [{}, {}]},
                "cells": {"tet4": {"dtype": "int32", "axes": [{}, {}]}},
            }}
            recorded = materialize_record_value(field, schema, resources=resources, artifacts=artifacts,
                                                owner="snapshot", leases=leases)
            encoded, attachments, _ = encode_recorded_data(name, schema, recorded, 1)
            assert encoded["values"]["axes"][1] == {"name": "time", "unit": "s", "ticks": [.0375]}
            assert encoded["values"]["shape"] == ([2, 1] if name == "pressure" else [2, 1, 3])
            assert (encoded["values"]["storage"]["kind"] == "attachments") is attached
            decoded = decode_tensor_tree(schema, encoded, {blob.id: bytes(blob.data) for blob in attachments})
            np.testing.assert_array_equal(decoded["values"][:, 0], getattr(solution, name))
            assert decoded["metadata.pressureKind"] == "gauge"
            assert decoded["metadata.pressureReference"] == domain.metadata["pressureReference"]
    finally:
        for lease in leases:
            resources.release(lease)
        artifacts.close()
        assert resources.stats().resource_count == 0
        resources.close()
