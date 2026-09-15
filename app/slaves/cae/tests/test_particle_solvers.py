"""Geometry-driven SPH/MPM ABI calls, typed checkpoints and passive outputs."""

from copy import deepcopy
from dataclasses import replace

import numpy as np
import pytest

from app.kernel.api import ParticleSetValue, SolverInvocation
from app.kernel.catalog import solver_catalog
from app.kernel.coordinator.contracts import validate_artifact_payload
from app.kernel.resources import ResourceStore, StateStore
from app.methods.geometry import GeometryService
from app.solvers.sph.entry import implementation as sph
from app.solvers.sph.domain import wall_faces
from app.solvers.mpm.entry import implementation as mpm
from tests.test_geometry_solids import boolean, box, scene, transformed


def invocation(prefix, *, window=0.002, duration=0.004, output=0.003):
    roots = []
    if prefix == "sph":
        definitions = [("body", [.4, 1, .4], [.2, .5, .2], "fluid"),
                       ("bottom", [.4, .2, .4], [.2, -.1, .2], "wall"),
                       ("top", [.4, .2, .4], [.2, 1.1, .2], "wall"),
                       ("domain", [.4, 1, .4], [.2, .5, .2], None)]
        kind, role, model = "fluid", "fluid", "fluidDynamics.newtonian-fluid@1"
        coefficients = {"density": {"value": 1000}, "dynamicViscosity": {"value": 100}}
        domain = {"methodId": "sph.domain", "target": ["experiment.geometry.domain"], "parameters": {"periodicX": True, "periodicY": False, "periodicZ": True}}
        general = {"hFactor": 1.3, "soundSpeed": 10, "densityExponent": 7}
    else:
        definitions = [("body", [.4, .4, .4], [.5, .5, .5], "solid"),
                       ("bottom", [.8, .2, .8], [.5, .2, .5], "wall"),
                       ("domain", [1, 1, 1], [.5, .5, .5], None)]
        kind, role, model = "particles", "solid", "mechanics.compressible-neo-hookean@1"
        coefficients = {"density": {"value": 1000}, "E": {"value": 10000}, "nu": {"value": .25}}
        domain = {"methodId": "mpm.grid", "target": ["experiment.geometry.domain"], "parameters": {"gridShape": [10, 10, 10]}}
        general = {}
    for name, size, center, material in definitions:
        root = {"id": name, "node": transformed(box(name, size), center)}
        if material:
            root["material"] = {"name": material}
        roots.append(root)
    scene = {"geometryHash": repr(roots), "lengthUnit": "m", "roots": roots,
             "geometryGroups": [{"name": root["id"], "rootIds": [root["id"]]} for root in roots], "surfaceGroups": []}
    empty = {"geometryHash": "empty", "lengthUnit": "m", "roots": [], "geometryGroups": [], "surfaceGroups": []}
    world = {"experiment": scene, "task": empty,
             "materials": {"experiment": {role: {"models": {"physical": {"model": model, "parameters": coefficients}}}, "wall": {"models": {}}}, "task": {}},
             "materialSelections": {"body": {role: {"fluid" if prefix == "sph" else "constitutive": "physical"}}}}
    rules = [{"methodId": f"{prefix}.body", "target": ["experiment.geometry.body"], "parameters": {"kind": kind, "spacing": .1}},
             {"methodId": f"{prefix}.time", "target": [], "parameters": {"dt": .001, "duration": duration, "windowSize": window, "outputInterval": output}}, domain]
    for name, *_ in definitions:
        if name not in {"body", "domain"}:
            rules.append({"methodId": f"{prefix}.body", "target": [f"experiment.geometry.{name}"], "parameters": {"kind": "fixed-wall"}})
    config = {"parameters": general, "initializations": rules, "boundaryConditions": [
        {"methodId": f"{prefix}.gravity", "target": ["experiment.geometry.body"], "parameters": {"acceleration": [.2, 0, 0] if prefix == "sph" else [0, -9.81, 0]}}], "outputs": [], "exports": []}
    descriptor = {"methods": {"outputs": [], "exports": []}, "visualizations": {},
                  "observations": {name: {} for name in ("time", "particleCount", "stepCount", "kineticEnergy")}}
    return SolverInvocation(config, {}, {}, world, GeometryService(), None, descriptor, task_name="motion")


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix,implementation", [("sph", sph), ("mpm", mpm)])
async def test_geometry_generated_typed_checkpoint_and_split_continuation(prefix, implementation):
    case = invocation(prefix)
    first = await implementation(case)
    saved = first.state_patch.operations[-1].value
    assert isinstance(saved["state"], ParticleSetValue)
    assert len(saved["state"].positions) > 1
    assert saved["state"].metadata["provenance"]["rootIds"] == ("experiment:body",) * len(saved["state"].positions)
    assert saved["state"].materials[0]["name"] in {"fluid", "solid"}
    assert case.state == {}
    positions_before = saved["state"].positions.copy()
    resumed = replace(case, state={prefix: {"motion": saved}})
    final = (await implementation(resumed)).state_patch.operations[-1].value
    continuous = (await implementation(invocation(prefix, window=.004))).state_patch.operations[-1].value
    np.testing.assert_allclose(final["state"].positions, continuous["state"].positions, rtol=0, atol=1e-14)
    np.testing.assert_allclose(final["state"].attributes["velocity"].values, continuous["state"].attributes["velocity"].values, rtol=0, atol=1e-14)
    np.testing.assert_array_equal(saved["state"].positions, positions_before)
    np.testing.assert_array_equal(final["state"].particle_ids, saved["state"].particle_ids)
    assert final["time"] == .004


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix,implementation", [("sph", sph), ("mpm", mpm)])
async def test_observation_clock_is_passive_and_physical_changes_reject_checkpoint(prefix, implementation):
    case = invocation(prefix, window=.004)
    baseline = (await implementation(case)).state_patch.operations[-1].value
    alternate = (await implementation(invocation(prefix, window=.004, output=.0007))).state_patch.operations[-1].value
    np.testing.assert_array_equal(baseline["state"].positions, alternate["state"].positions)
    first_case = invocation(prefix)
    saved = (await implementation(first_case)).state_patch.operations[-1].value
    changed = deepcopy(first_case.config)
    changed["initializations"][0]["parameters"]["spacing"] = .09
    with pytest.raises(ValueError, match="different Geometry"):
        await implementation(replace(first_case, config=changed, state={prefix: {"motion": saved}}))


@pytest.mark.asyncio
async def test_sph_requires_canonical_full_walls_and_particle_material():
    case = invocation("sph")
    config = deepcopy(case.config)
    config["initializations"] = [rule for rule in config["initializations"] if "experiment.geometry.top" not in rule["target"]]
    with pytest.raises(ValueError, match="matching fixed-wall"):
        await sph(replace(case, config=config))
    world = deepcopy(case.world)
    world["materialSelections"]["body"]["fluid"] = {}
    with pytest.raises(ValueError, match="newtonian-fluid"):
        await sph(replace(case, world=world))


@pytest.mark.asyncio
async def test_sph_boolean_container_retains_inner_faces_and_rejects_solid_fill():
    center = [.2, .5, .2]
    outer = transformed(box("outer", [.6, 1.2, .6]), center)
    inner = transformed(box("inner", [.4, 1, .4]), center)
    node = boolean("container", "subtract", outer, inner)
    geometry = GeometryService()
    mesh = await geometry.triangular_mesh(scene(node), "body", "m")
    assert wall_faces(mesh, np.zeros(3), np.array([.4, 1, .4])) == {(axis, side) for axis in range(3) for side in (0, 1)}
    filled = await geometry.triangular_mesh(scene(inner), "body", "m")
    with pytest.raises(ValueError, match="actual canonical surface"):
        wall_faces(filled, np.zeros(3), np.array([.4, 1, .4]))


@pytest.mark.asyncio
async def test_mpm_affine_compression_initialization_and_fixed_base():
    case = invocation("mpm", window=.004)
    case.config["initializations"].append({"methodId": "mpm.initial-motion", "target": ["experiment.geometry.body"],
                                           "parameters": {"velocity": [0, -.02, 0], "velocityGradient": [[0, 0, 0], [0, -.1, 0], [0, 0, 0]]}})
    saved = (await mpm(case)).state_patch.operations[-1].value
    assert len(saved["model"]["settings"]["fixedNodes"]) > 0
    assert np.mean(np.linalg.det(saved["state"].attributes["deformationGradient"].values)) < 1
    assert np.min(saved["state"].attributes["stress"].values[:, 1, 1]) < 0


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix,implementation", [("sph", sph), ("mpm", mpm)])
async def test_catalog_native_visuals_and_immutable_resource_checkpoint(prefix, implementation):
    case = invocation(prefix)
    descriptor = solver_catalog.descriptor(prefix, "2.0.0" if prefix == "mpm" else "1.0.0")
    case.config["exports"] = [{"methodId": f"{prefix}.particles", "key": "native", "parameters": {}}]
    case = replace(case, descriptor=descriptor)
    result = await implementation(case)
    assert result.exports["native"].identity == result.state_patch.operations[-1].value["state"].identity
    validate_artifact_payload(result.exports["native"], descriptor["methods"]["exports"][0]["data"], "native")
    for name, value in result.visualizations.items():
        validate_artifact_payload(value, descriptor["visualizations"][name]["data"], name)
    resources = ResourceStore()
    states = StateStore(resources)
    try:
        checkpoint = states.commit(None, result.state_patch, producer_task="motion")
        saved = checkpoint[prefix]["motion"]
        particles = saved["state"]
        assert not particles.positions.flags.writeable
        assert not particles.attributes["velocity"].values.flags.writeable
        assert np.shares_memory(particles.attributes["mass"].values, saved["model"]["mass"])
        before = particles.positions.copy()
        continued = await implementation(replace(case, state=checkpoint))
        np.testing.assert_array_equal(particles.positions, before)
        native = continued.exports["native"]
        np.testing.assert_array_equal(native.particle_ids, particles.particle_ids)
        if prefix == "mpm":
            reference = saved["model"]["referencePositions"]
            assert not reference.flags.writeable
            np.testing.assert_array_equal(native.particle_ids, saved["model"]["particleIds"])
            np.testing.assert_allclose(native.attributes["displacement"].values, native.positions - reference)
            assert native.attributes["firstPiolaStress"].values.shape == (len(reference), 3, 3)
        assert native.metadata["time"] == .004
        assert "affineVelocityGradient" not in native.attributes
        assert "referenceVolume" not in native.attributes
    finally:
        states.close()
        resources.close()


@pytest.mark.asyncio
async def test_mpm_invalid_trial_retries_same_accepted_state_and_input_errors_do_not_retry(monkeypatch):
    from app.methods.continuum.hyperelastic import InvalidDeformationError
    from app.solvers.mpm import entry

    original = entry.step
    attempts = []

    def reject_first(*args):
        before = [array.copy() for array in args[:4]]
        candidate = original(*args)
        for array, snapshot in zip(args[:4], before):
            np.testing.assert_array_equal(array, snapshot)
        attempts.append((args[-1], before))
        if len(attempts) == 1:
            raise InvalidDeformationError("candidate outside material domain")
        return candidate

    monkeypatch.setattr(entry, "step", reject_first)
    result = await mpm(invocation("mpm"))
    assert attempts[1][0] == attempts[0][0] / 2
    for before, retry in zip(attempts[0][1], attempts[1][1]):
        np.testing.assert_array_equal(before, retry)
    assert result.state_patch.operations[-1].value["time"] == .002
    attempts.clear()

    def invalid_input(*args):
        attempts.append(args[-1])
        raise ValueError("unsupported setting")

    monkeypatch.setattr(entry, "step", invalid_input)
    case = invocation("mpm")
    with pytest.raises(ValueError, match="unsupported setting"):
        await mpm(case)
    assert len(attempts) == 1 and case.state == {}


@pytest.mark.asyncio
async def test_mpm_new_outputs_and_visualizations_do_not_change_physical_state():
    case = invocation("mpm", window=.004)
    baseline = (await mpm(case)).state_patch.operations[-1].value
    descriptor = solver_catalog.descriptor("mpm", "2.0.0")
    geometry = {"origin": [0, 0, 0], "size": [1, 1, 1], "rotation": np.eye(3).tolist(),
                "gridShape": [7, 8, 9], "lengthUnit": "m", "source": "task", "rootId": "probe"}
    config = deepcopy(invocation("mpm", window=.004, output=.0007).config)
    config["outputs"] = [{"methodId": method, "key": method, "parameters": {}, "boxGrid": geometry}
                         for method in ("mpm.displacement", "mpm.reference-stress-field", "mpm.volume-ratio")]
    observed = await mpm(replace(case, config=config, descriptor=descriptor))
    actual = observed.state_patch.operations[-1].value
    assert actual["steps"] == baseline["steps"]
    np.testing.assert_array_equal(actual["state"].positions, baseline["state"].positions)
    for name in baseline["state"].attributes:
        np.testing.assert_array_equal(actual["state"].attributes[name].values, baseline["state"].attributes[name].values)
    assert observed.visualizations
    assert len(observed.artifacts) == 3
