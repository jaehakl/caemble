"""Spectral solutions and exports keep their own physical and lifetime meaning."""

from tests.structural_fixture import tetrahedron_motion

from types import SimpleNamespace

import numpy as np
import pytest

from app.kernel.api import BundleValue, FieldValue
from app.kernel.catalog import solver_catalog
from app.kernel.coordinator.contracts import validate_artifact_payload
from app.kernel.resources import ResourceStore
from app.solvers.structural_mechanics.analyses.harmonic import solve_harmonic
from app.solvers.structural_mechanics.constraints import constraint_transform
from app.solvers.structural_mechanics.continuum import integration_points
from app.solvers.structural_mechanics.interfaces.harmonic_surface import harmonic_surface_motion
from app.solvers.structural_mechanics.model import Element
from app.solvers.structural_mechanics.operators.linear import prepare_matrices
from app.solvers.structural_mechanics.outputs.visualizations import build_visualizations
from app.solvers.structural_mechanics.outputs.build import build_outputs
from tests.box_grid_fixtures import grid
from tests.structural_fixture import spring_model


@pytest.mark.asyncio
async def test_harmonic_is_independent_of_time_state_and_reports_every_frequency():
    model = spring_model(mass=2., stiffness=50., damping=3., force=1.)
    operators = prepare_matrices(model)
    transform = constraint_transform(model, np.tile(np.eye(3), (len(model.points), 1, 1)))
    progress = []

    async def report(value):
        progress.append(value["completed"])

    solution = await solve_harmonic(operators, transform, [.1, .5, 1.2], model.force, progress=report)
    assert solution.complex_displacement.dtype == np.complex128
    assert not hasattr(solution, "history") and not hasattr(solution, "time")
    assert progress == [1, 2, 3]
    assert solution.relative_residuals.max() < 1e-12


@pytest.mark.asyncio
@pytest.mark.parametrize("frequencies", [[0.], [-1.], [2., 1.], [1., 1.], [np.nan], []])
async def test_harmonic_rejects_invalid_frequency_coordinates(frequencies):
    model = spring_model()
    operators = prepare_matrices(model)
    transform = constraint_transform(model, np.tile(np.eye(3), (len(model.points), 1, 1)))
    with pytest.raises(ValueError, match="finite, positive and strictly increasing"):
        await solve_harmonic(operators, transform, frequencies, model.force)


@pytest.mark.asyncio
async def test_harmonic_cancellation_checked_between_frequencies():
    model = spring_model()
    checks = []

    def check():
        checks.append(1)
        if len(checks) == 2:
            raise RuntimeError("cancelled")

    with pytest.raises(RuntimeError, match="cancelled"):
        await solve_harmonic(prepare_matrices(model), constraint_transform(model, np.eye(3)[None]), [1., 2., 3.], model.force, SimpleNamespace(raise_if_cancelled=check))
    assert len(checks) == 2


def test_surface_export_is_reference_mesh_phasor_and_excludes_auxiliary_nodes():
    model, solution = tetrahedron_motion()
    artifact = harmonic_surface_motion(model, solution, ["experiment.surface.radiating"])
    assert isinstance(artifact, BundleValue)
    field = artifact.members["velocity"]
    assert isinstance(field, FieldValue)
    assert field.values.shape == (3, 2, 3)
    assert field.values.dtype == np.complex64
    assert field.location == "node" and field.unit == "m.s-1"
    np.testing.assert_array_equal(field.domain.points, model.points[:3])
    np.testing.assert_array_equal(field.domain.cells["tri3"], [[0, 2, 1]])
    np.testing.assert_allclose(field.values, np.moveaxis(1j * (2 * np.pi * solution.frequencies)[:, None, None] * solution.complex_displacement[:, :3, :3], 0, 1), rtol=1e-7)
    assert artifact.metadata["timeConvention"] == "exp(+i*omega*t)"
    assert artifact.metadata["amplitude"] == "peak" and artifact.metadata["configuration"] == "reference"
    assert field.domain.metadata["sourceModelIdentity"] == "source-solid"
    np.testing.assert_array_equal(field.domain.metadata["sourceMeshNodeIds"], [21, 22, 23])

    producer, consumer = ResourceStore(), ResourceStore()
    try:
        root = producer.ingest(artifact)
        lease = producer.acquire(root)
        copied = consumer.ingest(producer.materialize(root, mutable=False))
        consumer_lease = consumer.acquire(copied)
        producer.release(lease)
        received = consumer.resolve(copied)
        np.testing.assert_array_equal(received.members["velocity"].values, field.values)
        np.testing.assert_array_equal(received.members["velocity"].domain.cells["tri3"], [[0, 2, 1]])
        consumer.release(consumer_lease)
    finally:
        producer.close()
        consumer.close()


def test_surface_export_rejects_nonharmonic_and_interior_faces():
    model, solution = tetrahedron_motion()
    with pytest.raises(ValueError, match="requires harmonic"):
        harmonic_surface_motion(model, SimpleNamespace(), ["experiment.surface.radiating"])
    model.elements.append(Element("tet4", np.array([0, 2, 1, 4]), model.elements[0].material))
    with pytest.raises(ValueError, match="exterior physical faces"):
        harmonic_surface_motion(model, solution, ["experiment.surface.radiating"])


def test_surface_selection_order_and_duplicate_targets_preserve_mesh_identity_and_aliases():
    model, solution = tetrahedron_motion()
    model.boundary_regions["experiment.surface.second"] = {"faces": np.array([[0, 1, 3]]), "rootIds": ["solid"]}
    model.provenance = {
        "boundaryFaces": np.array([[0, 2, 1], [0, 1, 3]]),
        "boundaryProvenance": {"offsets": np.array([0, 1, 2]), "sources": ["experiment", "experiment"],
                               "rootIds": ["solid", "solid"], "sourceNodeIds": ["primitive-shape", "primitive-shape"],
                               "surfaceIndices": [0, 2]},
    }
    targets = ["experiment.surface.radiating", "experiment.surface.second"]
    first = harmonic_surface_motion(model, solution, targets).members["velocity"].domain
    second = harmonic_surface_motion(model, solution, [*reversed(targets), targets[0]]).members["velocity"].domain
    assert first.identity == second.identity
    np.testing.assert_array_equal(first.cells["tri3"], second.cells["tri3"])
    aliases = first.metadata["boundaryProvenance"]
    np.testing.assert_array_equal(aliases["sourceNodeIds"], ["primitive-shape", "primitive-shape"])
    np.testing.assert_array_equal(aliases["surfaceIndices"], [0, 2])
    np.testing.assert_array_equal(aliases["offsets"], [0, 1, 2])


def test_harmonic_record_and_native_export_share_the_solution_independently_of_probe_box():
    model, solution = tetrahedron_motion()
    descriptor = solver_catalog.descriptor("structural-mechanics", "8.0.0")
    probe = grid(shape=(1, 1, 1), origin=(.15, .15, .15), size=(.1, .1, .1))
    config = {"parameters": {"analysis": "harmonic"}, "outputs": [{"methodId": "fea.harmonic-displacement", "key": "displacement", "parameters": {}, "boxGrid": probe.geometry}],
              "exports": [{"methodId": "fea.harmonic-surface-motion", "key": "surfaceMotion", "target": ["experiment.surface.radiating"]}]}
    records, exports, _ = build_outputs(config, descriptor, model, solution)
    packed = records["displacement"]["value"][0, 0, 0, 0]
    reconstructed = packed[:, 0, :] * np.exp(1j * packed[:, 1, :])
    weights = np.array([.4, .2, .2, .2])
    np.testing.assert_allclose(reconstructed, np.einsum("n,fnc->fc", weights, solution.complex_displacement[:, :4, :3]), rtol=1e-14)
    np.testing.assert_array_equal(records["displacement"]["axes"][4]["ticks"], solution.frequencies)
    method = next(item for item in descriptor["methods"]["exports"] if item["methodId"] == "fea.harmonic-surface-motion")
    validate_artifact_payload(exports["surfaceMotion"], method["data"], "surfaceMotion")
    config["outputs"][0]["boxGrid"] = grid(shape=(1, 1, 1), origin=(4., 4., 4.)).geometry
    outside, same_export, _ = build_outputs(config, descriptor, model, solution)
    assert not outside["displacement"]["value"].any()
    np.testing.assert_array_equal(same_export["surfaceMotion"].members["velocity"].values, exports["surfaceMotion"].members["velocity"].values)


def test_catalog_harmonic_visuals_use_true_complex_displacement_and_stress():
    model, solution = tetrahedron_motion()
    descriptor = solver_catalog.descriptor("structural-mechanics", "8.0.0")
    visuals = build_visualizations({"parameters": {"analysis": "harmonic"}}, descriptor, model, solution)
    assert set(visuals) == {"harmonicDisplacement", "harmonicStress"}
    for name, value in visuals.items():
        validate_artifact_payload(value, descriptor["visualizations"][name]["data"], name)
    field = visuals["harmonicDisplacement"].members["field"]
    np.testing.assert_allclose(field.values, np.moveaxis(solution.complex_displacement[:, :4, :3], 0, 1), rtol=1e-7)
    assert field.metadata["sampleAxes"][0]["axis"] == 1
    B = integration_points("tet4", model.points[:4])[0][1]
    expected = solution.complex_displacement[:, :4, :3].reshape(2, 12) @ B.T @ model.elements[0].material["C"].T
    np.testing.assert_allclose(visuals["harmonicStress"].members["field"].values[0], expected, rtol=1e-7)
