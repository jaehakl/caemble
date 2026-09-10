"""Public CSG preparation: no authored mesh IDs, with independent physics checks."""

from copy import deepcopy
from dataclasses import replace
import hashlib
import json
from types import SimpleNamespace

import numpy as np
import pytest

from app.kernel.api import BundleValue, SolverInvocation
from app.kernel.resources import FileResourceCache
from app.methods.geometry import GeometryService
from app.solvers.structural_mechanics.analysis import initial_solution, static_analysis
from app.solvers.structural_mechanics.coupling import apply_resultant_loads, initialize_motion
from app.solvers.structural_mechanics.domain import build_geometry_model, distribute_resultant
from app.solvers.structural_mechanics.entry import run
from app.solvers.structural_mechanics.formulation import prepare_matrices, structural_response
from app.solvers.structural_mechanics.state import encode_state, read_state


class UnexpectedGeometry:
    async def volume_mesh(self, *_args, **_kwargs):
        raise AssertionError("configuration guard must run before meshing")


def solid_invocation(resolution=.3, second=False):
    roots = []
    surfaces = []
    for name, center in (("body", .5), ("extension", 1.5))[:2 if second else 1]:
        roots.append({"id": name, "material": {"name": "Steel"}, "node": {
            "kind": "transform", "nodeId": name + "-placement",
            "matrix": [1, 0, 0, center, 0, 1, 0, .2, 0, 0, 1, .2, 0, 0, 0, 1],
            "child": {"kind": "primitive", "nodeId": name + "-box", "primitive": "box", "parameters": {"size": [1, .4, .4]}},
        }})
        for index, face in enumerate(("left", "right", "front", "back", "bottom", "top")):
            surfaces.append({"name": name + "-" + face, "selectors": [{"rootId": name, "sourceNodeId": name + "-box", "surfaceIndex": index}]})
    scene = {"lengthUnit": "m", "roots": roots, "geometryGroups": [{"name": "all", "rootIds": [r["id"] for r in roots]}, *[{"name": r["id"], "rootIds": [r["id"]]} for r in roots]], "surfaceGroups": surfaces}
    scene["geometryHash"] = hashlib.sha256(json.dumps(scene, sort_keys=True).encode()).hexdigest()
    world = {"experiment": scene, "materialSelections": {"bodyDomain": {"Steel": {"constitutive": "solid"}}},
             "materials": {"experiment": {"Steel": {"models": {"solid": {"model": "mechanics.isotropic-elastic@1", "parameters": {"E": 210e9, "nu": .3, "density": 7850.}}}}}}}
    config = {
        "parameters": {"analysis": "static", "geometricNonlinear": False, "spatialResolution": resolution, "relativeTolerance": 1e-9, "maxIterations": 30},
        "initializations": [{"methodId": "fea.body", "target": ["experiment.geometry.all"], "parameters": {}}],
        "boundaryConditions": [
            {"methodId": "fea.fixed", "target": ["experiment.surface.body-left"], "parameters": {"components": ["x", "y", "z"]}},
            {"methodId": "fea.surface-load", "target": ["experiment.surface." + ("extension" if second else "body") + "-right"], "parameters": {"force": [10000., 0., 0.], "moment": [0., 0., 0.], "referencePoint": [2. if second else 1., .2, .2]}},
        ], "outputs": [],
    }
    return SolverInvocation(config, {}, {}, world, GeometryService(), None, {}, task_name="solid")


@pytest.mark.asyncio
async def test_generated_mesh_exact_affine_patch_and_resolution_invariant_surfaces(tmp_path):
    identities = []
    counts = []
    for resolution in (.3, .2):
        invocation = solid_invocation(resolution)
        # Plane symmetry supports allow exact uniform Poisson contraction.
        invocation.config["boundaryConditions"][0]["parameters"]["components"] = ["x"]
        invocation.config["boundaryConditions"].extend([
            {"methodId": "fea.fixed", "target": ["experiment.surface.body-front"], "parameters": {"components": ["y"]}},
            {"methodId": "fea.fixed", "target": ["experiment.surface.body-bottom"], "parameters": {"components": ["z"]}},
        ])
        invocation = replace(invocation, geometry=GeometryService(cache=FileResourceCache(tmp_path)))
        model = await build_geometry_model(invocation)
        K, M, _, prepared = prepare_matrices(model)
        solution = static_analysis(model, prepared, K, M, tolerance=1e-10)
        strain = 10000 / (.16 * 210e9)
        expected = model.points * np.array([strain, -.3 * strain, -.3 * strain])
        np.testing.assert_allclose(solution.displacement[:, :3], expected, rtol=1e-8, atol=1e-15)
        np.testing.assert_allclose(solution.reaction[:, :3].sum(axis=0), [-10000, 0, 0], atol=1e-5)
        assert model.boundary_regions["experiment.surface.body-right"]["area"] == pytest.approx(.16)
        assert model.provenance["quality"]["cellVolumes"].sum() == pytest.approx(.16)
        assert model.provenance["quality"]["meanRatios"].min() > 0
        repeat = await build_geometry_model(invocation)
        assert repeat.identity == model.identity
        identities.append(model.identity)
        counts.append(len(model.points))
    assert identities[0] != identities[1]
    assert counts[1] > counts[0]


@pytest.mark.asyncio
async def test_csg_mesh_refinement_converges_clamped_volume_compliance():
    energies, counts = [], []
    for resolution in (.3, .2, .13):
        invocation = solid_invocation(resolution)
        model = await build_geometry_model(invocation)
        K, M, _, prepared = prepare_matrices(model)
        solution = static_analysis(model, prepared, K, M, tolerance=1e-10)
        energies.append(solution.strain_energy)
        counts.append(len(model.elements))
        assert model.boundary_regions["experiment.surface.body-left"]["area"] == pytest.approx(.16)
        assert model.boundary_regions["experiment.surface.body-right"]["area"] == pytest.approx(.16)
        np.testing.assert_allclose(solution.reaction[:, :3].sum(axis=0), [-10000, 0, 0], atol=1e-5)
        # Full end clamping restrains Poisson contraction. Its energy lies below
        # the independently known uniaxial free-contraction compliance, not a
        # legacy beam/shell result used as a supposed 3D equivalence target.
        assert 0 < solution.strain_energy < 10000**2 / (2 * 210e9 * .16)
    assert counts[0] < counts[1] < counts[2]
    increments = np.diff(energies)
    assert 0 < increments[1] < increments[0]
    assert increments[1] / energies[-1] < .01


@pytest.mark.asyncio
@pytest.mark.parametrize("targets, expected", [
    (["body-right"], [-32., 0., 0.]),
    (["extension-left"], [32., 0., 0.]),
    (["body-right", "extension-left"], [0., 0., 0.]),
])
async def test_bonded_interface_pressure_uses_each_material_sides_outward_normal(targets, expected):
    invocation = solid_invocation(second=True)
    invocation.config["initializations"].append({"methodId": "fea.bonded", "target": ["experiment.geometry.all"], "parameters": {}})
    invocation.config["boundaryConditions"] = [{
        "methodId": "fea.pressure", "target": ["experiment.surface." + target for target in targets],
        "parameters": {"pressure": 200.},
    }]
    model = await build_geometry_model(invocation)
    np.testing.assert_allclose(model.force[:, :3].sum(axis=0), expected, atol=1e-12)
    for target, outward in (("body-right", [1., 0., 0.]), ("extension-left", [-1., 0., 0.])):
        triangles = model.points[model.boundary_regions["experiment.surface." + target]["faces"]]
        area_vectors = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]) / 2
        np.testing.assert_allclose(area_vectors.sum(axis=0), .16 * np.asarray(outward), atol=1e-12)


@pytest.mark.asyncio
@pytest.mark.parametrize("angle", [0., .37])
async def test_offset_csg_bodies_bond_only_their_overlapping_planar_patch(angle):
    invocation = solid_invocation(second=True)
    scene = invocation.world["experiment"]
    scene["roots"][1]["node"]["matrix"][7] += .2
    rotation = np.array([[np.cos(angle), -np.sin(angle), 0.], [np.sin(angle), np.cos(angle), 0.], [0., 0., 1.]])
    for root in scene["roots"]:
        matrix = np.asarray(root["node"]["matrix"]).reshape(4, 4)
        matrix[:3] = rotation @ matrix[:3]
        root["node"]["matrix"] = matrix.ravel().tolist()
    load = invocation.config["boundaryConditions"][1]["parameters"]
    load["force"] = (rotation @ load["force"]).tolist()
    load["referencePoint"] = (rotation @ load["referencePoint"]).tolist()
    scene["geometryHash"] = hashlib.sha256(json.dumps(scene, sort_keys=True).encode()).hexdigest()
    invocation.config["initializations"].append({"methodId": "fea.bonded", "target": ["experiment.geometry.all"], "parameters": {}})
    model = await build_geometry_model(invocation)
    metadata = model.provenance
    interface = metadata["boundaryFaces"][np.diff(metadata["boundaryProvenance"]["offsets"]) == 2]
    triangles = model.points[interface]
    areas = np.linalg.norm(np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]), axis=1) / 2
    assert areas.sum() == pytest.approx(.08, rel=1e-10)
    local_triangles = triangles @ rotation
    assert np.allclose(local_triangles[:, :, 0], 1.)
    assert local_triangles[:, :, 1].min() == pytest.approx(.2)
    assert local_triangles[:, :, 1].max() == pytest.approx(.4)
    assert metadata["quality"]["cellVolumes"].sum() == pytest.approx(.32, rel=1e-10)
    root_nodes = [set(np.concatenate([element.nodes for element in model.elements if element.root_id == root])) for root in ("body", "extension")]
    assert root_nodes[0] & root_nodes[1] == set(interface.ravel())
    K, M, _, prepared = prepare_matrices(model)
    solution = static_analysis(model, prepared, K, M, tolerance=1e-10)
    np.testing.assert_allclose(solution.reaction[:, :3].sum(axis=0), -np.asarray(load["force"]), atol=1e-5)
    np.testing.assert_allclose(np.cross(model.points - load["referencePoint"], solution.reaction[:, :3]).sum(axis=0), 0, atol=1e-5)


@pytest.mark.asyncio
async def test_changed_geometry_or_profile_rejects_checkpoint():
    invocation = solid_invocation()
    model = await build_geometry_model(invocation)
    checkpoint = encode_state(model, initial_solution(model))
    changed = solid_invocation(.2)
    with pytest.raises(ValueError, match="different mesh/material/constraint/integration model"):
        read_state(await build_geometry_model(changed), checkpoint)
    changed = solid_invocation()
    changed.world["experiment"]["geometryHash"] = "changed-original-curve-definition"
    with pytest.raises(ValueError, match="different mesh/material/constraint/integration model"):
        read_state(await build_geometry_model(changed), checkpoint)


@pytest.mark.asyncio
@pytest.mark.parametrize("connection", ["fea.rigid-connection", "fea.revolute"])
async def test_surface_connections_generate_internal_reference_dofs(connection):
    invocation = solid_invocation(second=True)
    invocation.config["initializations"].append({"methodId": connection, "target": ["experiment.surface.body-right", "experiment.surface.extension-left"], "parameters": {"axis": "x"} if connection.endswith("revolute") else {}})
    if connection.endswith("revolute"):
        invocation.config["initializations"].append({"methodId": "fea.rotation-spring", "target": ["experiment.surface.extension-left"], "parameters": {"axisA": "x", "axisB": "x", "ratio": 1., "stiffness": 1e5, "damping": 0.}})
        invocation.config["boundaryConditions"][1]["parameters"]["moment"] = [10., 0, 0]
    model = await build_geometry_model(invocation)
    assert len(model.points) == model.physical_node_count + 2
    assert len(model.provenance["auxiliaryNodes"]) == 2
    K, M, _, prepared = prepare_matrices(model)
    solution = static_analysis(model, prepared, K, M, tolerance=1e-9)
    np.testing.assert_allclose(solution.reaction[:, :3].sum(axis=0), [-10000, 0, 0], atol=1e-4)
    assert np.all(np.isfinite(solution.displacement))
    assert np.max(solution.displacement[:model.physical_node_count, 0]) > 0


@pytest.mark.asyncio
async def test_surface_spring_and_body_initial_velocity_are_mesh_independent():
    invocation = solid_invocation()
    baseline = await build_geometry_model(invocation)
    K, M, _, prepared = prepare_matrices(baseline)
    free = static_analysis(baseline, prepared, K, M)
    stiffness = .16 * 210e9
    invocation.config["initializations"].append({"methodId": "fea.translation-spring", "target": ["experiment.surface.body-right"], "parameters": {"axisA": "x", "axisB": "x", "ratio": 1., "stiffness": stiffness, "damping": 1.}})
    model = await build_geometry_model(invocation)
    K, M, _, prepared = prepare_matrices(model)
    supported = static_analysis(model, prepared, K, M)
    nodes = model.boundary_regions["experiment.surface.body-right"]["nodes"]
    assert supported.displacement[nodes, 0].mean() / free.displacement[baseline.boundary_regions["experiment.surface.body-right"]["nodes"], 0].mean() == pytest.approx(.5, rel=.04)
    motion = [{"methodId": "fea.initial-motion", "target": ["experiment.geometry.body"], "parameters": {"initialVelocity": [1., 2., 3.], "initialAngularVelocity": [0., 0., 2.], "referencePoint": [.5, .2, .2]}}]
    solution = initialize_motion(model, motion)
    expected = [1., 2., 3.] + np.cross([0., 0., 2.], model.points - [.5, .2, .2])
    np.testing.assert_allclose(solution.velocity[:, :3], expected)


def test_area_weighted_surface_wrench_preserves_virtual_work():
    points = np.array([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [1., 1., 0.], [.2, .1, 0.]])
    faces = np.array([[0, 1, 4], [1, 3, 4], [3, 2, 4], [2, 0, 4]])
    force, moment, reference = np.array([10., 20., 30.]), np.array([4., 5., 6.]), np.array([.3, .4, .1])
    nodes, values = distribute_resultant(points, faces, force, moment, reference)
    np.testing.assert_allclose(values.sum(axis=0), force, atol=1e-12)
    np.testing.assert_allclose(np.cross(points[nodes] - reference, values).sum(axis=0), moment, atol=1e-12)
    translation, rotation = np.array([.2, -.1, .3]), np.array([.05, .1, -.07])
    work = np.sum(values * (translation + np.cross(rotation, points[nodes] - reference)))
    assert work == pytest.approx(force @ translation + moment @ rotation)


@pytest.mark.asyncio
async def test_public_geometry_builder_does_not_accept_explicit_mesh_fallback():
    invocation = solid_invocation()
    invocation.config["initializations"] = [{"methodId": "fea.nodes", "target": [], "parameters": {"positions": [[0, 0, 0]]}}]
    with pytest.raises(ValueError, match="explicit mesh input is not supported"):
        await build_geometry_model(invocation)


@pytest.mark.asyncio
async def test_public_geometry_builder_rejects_multiple_rotors_before_meshing():
    invocation = solid_invocation()
    rotor = {"methodId": "fea.rotor", "target": [], "parameters": {}}
    invocation.config["initializations"].extend([rotor, deepcopy(rotor)])

    invocation = replace(invocation, geometry=UnexpectedGeometry())
    with pytest.raises(ValueError, match="one fea.rotor"):
        await build_geometry_model(invocation)


@pytest.mark.parametrize("method", ["fea.material-frame", "fea.initial-motion"])
@pytest.mark.asyncio
async def test_body_initialization_rules_cannot_overlap_before_meshing(method):
    invocation = solid_invocation()
    rule = {"methodId": method, "target": ["experiment.geometry.body"], "parameters": {}}
    invocation.config["initializations"].extend([rule, deepcopy(rule)])
    invocation = replace(invocation, geometry=UnexpectedGeometry())
    with pytest.raises(ValueError, match="must not overlap"):
        await build_geometry_model(invocation)


@pytest.mark.asyncio
async def test_rotor_attachments_require_distinct_bodies_before_meshing():
    invocation = solid_invocation()
    invocation.config["initializations"].append({
        "methodId": "fea.rotor",
        "target": [
            "experiment.surface.body-left", "experiment.surface.body-right",
            "experiment.surface.body-front",
        ],
        "parameters": {},
    })
    invocation = replace(invocation, geometry=UnexpectedGeometry())
    with pytest.raises(ValueError, match="distinct CSG bodies"):
        await build_geometry_model(invocation)


@pytest.mark.asyncio
async def test_rotor_body_initial_motion_requires_explicit_superposition_before_meshing():
    invocation = solid_invocation(second=True)
    scene = invocation.world["experiment"]
    generator = deepcopy(scene["roots"][1])
    generator["id"] = "generator"
    generator["node"]["nodeId"] = "generator-placement"
    generator["node"]["child"]["nodeId"] = "generator-box"
    scene["roots"].append(generator)
    scene["geometryGroups"][0]["rootIds"].append("generator")
    scene["surfaceGroups"].append({
        "name": "generator-left",
        "selectors": [{"rootId": "generator", "sourceNodeId": "generator-box", "surfaceIndex": 0}],
    })
    invocation.config["initializations"].extend([
        {"methodId": "fea.initial-motion", "target": ["experiment.geometry.extension"], "parameters": {}},
        {"methodId": "fea.rotor", "target": [
            "experiment.surface.body-left", "experiment.surface.extension-left",
            "experiment.surface.generator-left",
        ], "parameters": {}},
    ])
    invocation = replace(invocation, geometry=UnexpectedGeometry())
    with pytest.raises(ValueError, match="explicit rotor superposition semantics"):
        await build_geometry_model(invocation)


@pytest.mark.parametrize("analysis", ["modal", "harmonic", "transient"])
@pytest.mark.asyncio
async def test_resultant_transfer_rejects_unsupported_analysis_before_meshing(analysis):
    invocation = solid_invocation()
    invocation.config["parameters"]["analysis"] = analysis
    invocation.config["boundaryConditions"].append({
        "methodId": "fea.resultant-transfer", "target": ["experiment.surface.body-right"],
        "parameters": {"sourceRegion": "experiment.surface.body-right", "referencePoint": [0., 0., 0.]},
    })

    invocation = replace(invocation, geometry=UnexpectedGeometry())
    with pytest.raises(ValueError, match="only for static and buckling"):
        await run(invocation)


@pytest.mark.parametrize("port", ["loads", "previousMotion", "control"])
@pytest.mark.asyncio
async def test_transient_coupling_ports_reject_other_analyses_before_meshing(port):
    invocation = solid_invocation()
    value = [SimpleNamespace()] if port == "loads" else SimpleNamespace()
    invocation = replace(invocation, inputs={port: value}, geometry=UnexpectedGeometry())
    with pytest.raises(ValueError, match="only for transient analysis"):
        await run(invocation)


@pytest.mark.asyncio
async def test_control_requires_rotor_before_meshing():
    invocation = solid_invocation()
    invocation.config["parameters"]["analysis"] = "transient"
    invocation = replace(invocation, inputs={"control": SimpleNamespace()}, geometry=UnexpectedGeometry())
    with pytest.raises(ValueError, match="requires a fea.rotor"):
        await run(invocation)


@pytest.mark.parametrize("port", ["sourceLoads", "sourceMotion"])
@pytest.mark.asyncio
async def test_source_coupling_ports_require_resultant_transfer_before_meshing(port):
    invocation = solid_invocation()
    value = [SimpleNamespace()] if port == "sourceLoads" else SimpleNamespace()
    invocation = replace(invocation, inputs={port: value}, geometry=UnexpectedGeometry())
    with pytest.raises(ValueError, match="require fea.resultant-transfer"):
        await run(invocation)


@pytest.mark.asyncio
async def test_resultant_transfer_selects_source_geometry_region_without_authored_node_ids():
    source = await build_geometry_model(solid_invocation(.3))
    target_invocation = solid_invocation(.2)
    target_invocation.config["boundaryConditions"] = target_invocation.config["boundaryConditions"][:1]
    region_name = "experiment.surface.body-right"
    target_invocation.config["boundaryConditions"].append({"methodId": "fea.resultant-transfer", "target": [region_name], "parameters": {"sourceRegion": region_name, "referencePoint": [.5, .2, .2]}})
    target = await build_geometry_model(target_invocation)
    source_nodes = source.boundary_regions[region_name]["nodes"]
    forces = np.zeros((1, len(source.points), 3))
    forces[0, source_nodes] = [1., 2., 3.]
    coordinates = {"modelIdentity": source.identity, "nodeIds": source.node_ids, "times": np.array([0.])}
    source_motion = BundleValue("caemble.mechanics/motion@1", {**coordinates, "positions": source.points[None]}, {"regions": {region_name: source.node_ids[source_nodes]}})
    source_loads = BundleValue("fixture.loads", {**coordinates, "forces": forces, "moments": np.zeros_like(forces)})
    target_invocation = replace(target_invocation, inputs={"sourceMotion": SimpleNamespace(value=source_motion), "sourceLoads": [SimpleNamespace(value=source_loads)]})
    apply_resultant_loads(target_invocation, target)
    reference = [.5, .2, .2]
    np.testing.assert_allclose(target.force[:, :3].sum(axis=0), forces.sum(axis=(0, 1)), atol=1e-10)
    np.testing.assert_allclose(np.cross(target.points - reference, target.force[:, :3]).sum(axis=0), np.cross(source.points - reference, forces[0]).sum(axis=0), atol=1e-10)
    target_invocation.config["boundaryConditions"][-1]["parameters"] = {
        "sourceNodeIds": [int(source.node_ids[source_nodes[0]])],
        "targetNodeIds": [int(target.node_ids[target.boundary_regions[region_name]["nodes"][0]])],
        "referencePoint": reference,
    }
    with pytest.raises(ValueError, match="require a semantic sourceRegion"):
        apply_resultant_loads(target_invocation, target)


@pytest.mark.asyncio
async def test_csg_rotor_initial_azimuth_and_pitch_preserve_volume_without_fake_rotational_mass():
    invocation = solid_invocation(second=True)
    scene = invocation.world["experiment"]
    for name, offset in (("generator", -1.), ("blade", 0.)):
        root = deepcopy(scene["roots"][1])
        root["id"] = name
        root["node"]["nodeId"] = name + "-placement"
        root["node"]["child"]["nodeId"] = name + "-box"
        root["node"]["matrix"][3] += offset
        if name == "blade":
            root["node"]["matrix"][7] += 1.
        scene["roots"].append(root)
        scene["geometryGroups"][0]["rootIds"].append(name)
        scene["surfaceGroups"].append({"name": name + "-left", "selectors": [{"rootId": name, "sourceNodeId": name + "-box", "surfaceIndex": 0}]})
    scene["geometryHash"] = hashlib.sha256(json.dumps(scene, sort_keys=True).encode()).hexdigest()
    invocation.config["parameters"]["geometricNonlinear"] = True
    invocation.config["initializations"].append({"methodId": "fea.rotor", "target": ["experiment.surface.body-right", "experiment.surface.extension-left", "experiment.surface.generator-left", "experiment.surface.blade-left"], "parameters": {"initialRotorSpeed": .5, "initialAzimuth": .4, "initialPitch": .2, "gearRatio": 2., "shaftStiffness": 1e4, "shaftDamping": 1.}})
    model = await build_geometry_model(invocation)
    solution = initialize_motion(model, invocation.config["initializations"])
    for element in model.elements:
        original = model.points[element.nodes]
        current = original + solution.displacement[element.nodes, :3]
        for left, right in ((0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)):
            assert np.linalg.norm(current[right] - current[left]) == pytest.approx(np.linalg.norm(original[right] - original[left]), rel=1e-10)
    assert len(model.points) == model.physical_node_count + 4
    assert np.max(np.linalg.norm(solution.velocity[:model.physical_node_count, :3], axis=1)) > 0
    _, _, _, prepared = prepare_matrices(model)
    internal, _, _, _, energy = structural_response(
        model, solution.displacement, solution.orientations, prepared, None,
        geometric=True, approximate_tangent=True,
    )
    assert energy < 1e-12
    assert np.linalg.norm(internal) < 1e-3
