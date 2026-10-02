"""Conservative shared subcell observations and native rigid snapshot contracts."""

import asyncio
from types import SimpleNamespace

import numpy as np
import pytest

from app.kernel.api import ContentKey
from app.methods.fields.box_grid import BoxGrid
from app.methods.geometry import GeometryService
from app.methods.rigid import quaternion_exp, quaternion_to_matrix
from app.solvers.rigid_body.domain import build_model, model_request
from app.solvers.rigid_body.evolution import append_history
from app.solvers.rigid_body.outputs import build_native, build_outputs, sample_cells


def box(name, size):
    return {"kind": "primitive", "nodeId": name, "primitive": "box", "parameters": {"size": size}}


def transformed(node, position=(0, 0, 0), rotation=None):
    matrix = np.eye(4)
    matrix[:3, 3] = position
    if rotation is not None:
        matrix[:3, :3] = rotation
    return {"kind": "transform", "nodeId": node["nodeId"] + "-transform", "matrix": matrix.ravel().tolist(), "child": node}


def make_model(nodes, densities=None, velocities=None, omegas=None):
    count = len(nodes)
    densities = [2.] * count if densities is None else densities
    velocities = np.zeros((count, 3)) if velocities is None else velocities
    omegas = np.zeros((count, 3)) if omegas is None else omegas
    roots, groups, materials, selections, initializations = [], [], {}, {}, []
    for index, node in enumerate(nodes):
        name = f"body{index}"
        roots.append({"id": name, "material": {"name": name}, "node": node})
        groups.append({"name": name, "rootIds": [name]})
        materials[name] = {"models": {"mass": {"model": "mechanics.mass-density@1", "parameters": {"density": densities[index]}}}}
        selections[name] = {"density": "mass"}
        target = [f"experiment.geometry.{name}"]
        initializations.extend([
            {"methodId": "rigid.body", "target": target, "parameters": {}},
            {"methodId": "rigid.initial-motion", "target": target,
             "parameters": {"velocity": velocities[index], "angularVelocity": omegas[index]}},
        ])
    scene = {"version": 2, "geometryHash": str(ContentKey.from_parts("test", roots)), "lengthUnit": "m",
             "roots": roots, "geometryGroups": groups}
    invocation = SimpleNamespace(
        config={"parameters": {"massAngularSegments": 64}, "initializations": initializations, "boundaryConditions": []},
        world={"experiment": scene, "materials": {"experiment": materials}, "materialSelections": {"body": selections}},
        cancellation=None, progress=None, geometry=GeometryService(),
    )
    return asyncio.run(build_model(invocation, model_request(invocation)))


def grid(shape=(1, 1, 1), origin=(-.5, -.5, -.5), size=(1, 1, 1), rotation=None, unit="m"):
    return BoxGrid({"source": "task", "rootId": "probe", "lengthUnit": unit, "gridShape": list(shape),
                    "origin": list(origin), "size": list(size),
                    "rotation": (np.eye(3) if rotation is None else rotation).tolist()})


def sample(model, state, probe, subdivisions=4):
    return asyncio.run(sample_cells(model, state, probe, subdivisions))


def test_partial_cell_velocity_is_mass_weighted_over_material_not_cell_center():
    model, state = make_model([box("solid", [1, 1, 1])], velocities=[[1, 2, 3]], omegas=[[0, 0, 2]])
    values = sample(model, state, grid(origin=(0, -.5, -.5)))
    # Material occupies only x=[0,.5], whose average position is .25, not .5.
    np.testing.assert_allclose(values["rigid.mass-density"], 1)
    np.testing.assert_allclose(values["rigid.velocity"][0, 0, 0], [1, 2.5, 3])
    np.testing.assert_allclose(values["rigid.momentum-density"][0, 0, 0], [1, 2.5, 3])
    empty = sample(model, state, grid(origin=(4, 4, 4)))
    assert all(np.all(value == 0) and np.all(np.isfinite(value)) for value in empty.values())


def test_overlapping_bodies_add_mass_and_momentum_with_shared_velocity_weights():
    model, state = make_model([box("first", [1, 1, 1]), box("second", [1, 1, 1])],
                              densities=[2, 6], velocities=[[1, 0, 0], [-1, 2, 0]])
    values = sample(model, state, grid(shape=(2, 1, 1), origin=(-1, -.5, -.5), size=(2, 1, 1)))
    np.testing.assert_allclose(values["rigid.mass-density"], 4)
    np.testing.assert_allclose(values["rigid.velocity"], np.broadcast_to([-.5, 1.5, 0], (2, 1, 1, 3)))
    np.testing.assert_allclose(values["rigid.momentum-density"], np.broadcast_to([-2, 6, 0], (2, 1, 1, 3)))
    np.testing.assert_allclose(values["rigid.mass-density"] * values["rigid.velocity"], values["rigid.momentum-density"])


def test_rotated_millimeter_box_and_singleton_axes_preserve_world_velocity():
    rotation = quaternion_to_matrix(quaternion_exp([.3, -.5, .4]))
    center, size = np.array([1.5, -2, .3]), np.array([1, 2, 3])
    velocity, omega = np.array([.7, -.1, .4]), np.array([.2, -.3, .9])
    model, state = make_model([transformed(box("solid", size.tolist()), center, rotation)],
                              velocities=[velocity], omegas=[omega])
    origin = center - rotation @ (size / 2)
    probe = grid((1, 2, 1), origin * 1000, size * 1000, rotation, "mm")
    values = sample(model, state, probe)
    np.testing.assert_allclose(values["rigid.mass-density"], 2)
    expected = velocity + np.cross(omega, probe.points() - center)
    np.testing.assert_allclose(values["rigid.velocity"], expected, atol=2e-14)
    np.testing.assert_allclose(values["rigid.momentum-density"], 2 * expected, atol=4e-14)


def test_enclosed_cavity_cells_are_zero_and_density_integrates_material_mass():
    node = {"kind": "boolean", "nodeId": "hollow", "operation": "subtract",
            "children": [box("outer", [2, 2, 2]), box("hole", [1, 1, 1])]}
    model, state = make_model([node], velocities=[[.7, -.4, 1.2]], omegas=[[.3, .4, -.2]])
    probe = grid((4, 4, 4), (-1, -1, -1), (2, 2, 2))
    values = sample(model, state, probe)
    for value in values.values():
        assert np.all(value[1:3, 1:3, 1:3] == 0)
        assert np.all(np.isfinite(value))
    cell_volume = .5**3
    assert np.sum(values["rigid.mass-density"]) * cell_volume == pytest.approx(model["masses"].sum())
    np.testing.assert_allclose(values["rigid.momentum-density"].sum(axis=(0, 1, 2)) * cell_volume,
                               model["masses"] @ state["velocity"], atol=1e-13)


def test_subcell_two_four_eight_converge_on_exact_diagonal_surface_coincidences():
    rotation = quaternion_to_matrix(quaternion_exp([0, 0, np.pi / 4]))
    model, state = make_model([transformed(box("diamond", [np.sqrt(2), np.sqrt(2), 1]), rotation=rotation)], densities=[1])
    probe = grid((4, 4, 1), (-1, -1, -.5), (2, 2, 1))
    exact = np.array([[0, .5, .5, 0], [.5, 1, 1, .5], [.5, 1, 1, .5], [0, .5, .5, 0]])
    errors = []
    for subdivisions in (2, 4, 8):
        density = sample(model, state, probe, subdivisions)["rigid.mass-density"][:, :, 0, 0]
        errors.append(np.abs(density - exact).sum())
        assert np.all((density >= 0) & (density <= 1))
    assert errors[1] <= .51 * errors[0]
    assert errors[2] <= .51 * errors[1]
    assert errors[2] < .51


def test_resolved_asymmetric_holed_rotating_solid_conserves_mass_and_momentum():
    hole = {"kind": "primitive", "nodeId": "hole", "primitive": "cylinder",
            "parameters": {"radius": .22, "radius_2": .22, "height": 2, "segments": 64}}
    shape = {"kind": "boolean", "nodeId": "bracket", "operation": "subtract",
             "children": [box("plate", [1.5, 1.2, .8]), transformed(hole, [.32, .19, 0])]}
    rotation = quaternion_to_matrix(quaternion_exp([.21, -.32, .44]))
    model, state = make_model([transformed(shape, [.13, -.08, .12], rotation)], densities=[3.7],
                              velocities=[[.9, -.7, 1.1]], omegas=[[.4, .7, -.2]])
    probe = grid((12, 12, 12), (-1.2, -1.2, -1.2), (2.4, 2.4, 2.4))
    values = sample(model, state, probe, 8)
    cell_volume = .2**3
    sampled_mass = values["rigid.mass-density"].sum() * cell_volume
    sampled_momentum = values["rigid.momentum-density"].sum(axis=(0, 1, 2)) * cell_volume
    exact_momentum = model["masses"] @ state["velocity"]
    assert abs(sampled_mass / model["masses"].sum() - 1) < .01
    assert np.linalg.norm(sampled_momentum - exact_momentum) / np.linalg.norm(exact_momentum) < .01
    np.testing.assert_allclose(values["rigid.velocity"] * values["rigid.mass-density"],
                               values["rigid.momentum-density"], rtol=2e-16, atol=1e-15)


def test_quadrature_workspace_is_tiled_and_cancellation_is_checked(monkeypatch):
    model, state = make_model([box("large", [2, 2, 2])])
    probe = grid((20, 20, 20), (-1, -1, -1), (2, 2, 2))
    calls = []

    async def mask(mesh, x, y, z):
        calls.append((len(x), len(y), len(z)))
        return np.zeros((len(z), len(y), len(x)), dtype=bool)

    monkeypatch.setattr("app.solvers.rigid_body.outputs.rasterize_mesh_cell_centers", mask)
    sample(model, state, probe, 8)
    assert calls and max(z for _, _, z in calls) == 1
    assert max(x * y * z for x, y, z in calls) <= 160 * 128

    class Cancel:
        checks = 0

        def raise_if_cancelled(self):
            self.checks += 1
            if self.checks == 3:
                raise RuntimeError("cancelled")

    token = Cancel()
    with pytest.raises(RuntimeError, match="cancelled"):
        asyncio.run(sample_cells(model, state, probe, 8, token))
    assert token.checks == 3


def saved_history(state, end=.3):
    moved = {name: value.copy() for name, value in state.items()}
    moved["position"] += .1
    history = append_history({}, [{"times": 0., **state}, {"times": .2, **moved}])
    endpoint = {name: value.copy() for name, value in moved.items()}
    endpoint["position"] += .05
    return {"time": end, "history": history, **endpoint}


def output_definition(method, components):
    return {"methodId": method, "data": {"dtype": "float64", "boxGrid": {
        "version": 1, "sampling": "cell-average", "components": components,
        "channels": ["value"], "channelUnits": ["1"],
    }}}


def test_matching_outputs_reuse_quadrature_and_keep_seven_axes(monkeypatch):
    model, state = make_model([box("solid", [1, 1, 1])], velocities=[[1, 2, 3]])
    saved = saved_history(state)
    probe = grid((1, 2, 1), (-1, -1, -1), (2, 2, 2))
    calls = []
    from app.solvers.rigid_body import outputs
    original = outputs.sample_cells

    async def counted(*args, **kwargs):
        calls.append(1)
        return await original(*args, **kwargs)

    monkeypatch.setattr(outputs, "sample_cells", counted)
    definitions = [output_definition("rigid.mass-density", ["value"]),
                   output_definition("rigid.velocity", ["x", "y", "z"]),
                   output_definition("rigid.momentum-density", ["x", "y", "z"])]
    requested = [{"key": str(index), "methodId": item["methodId"], "parameters": {}, "boxGrid": probe.geometry}
                 for index, item in enumerate(definitions)]
    requested.append({**requested[0], "key": "final", "parameters": {"scope": "final"}})
    invocation = SimpleNamespace(config={"parameters": {"subcellSamplesPerAxis": 4}, "outputs": requested},
                                 descriptor={"methods": {"outputs": definitions}}, cancellation=None)
    values = asyncio.run(build_outputs(invocation, model, saved))
    assert len(calls) == 3  # Two cumulative samples shared by all fields, plus one final scope.
    assert values["0"]["value"].shape == (1, 2, 1, 2, 1, 1, 1)
    assert values["1"]["value"].shape == (1, 2, 1, 2, 1, 1, 3)
    assert values["final"]["value"].shape == (1, 2, 1, 1, 1, 1, 1)
    np.testing.assert_array_equal(values["final"]["axes"][3]["ticks"], [.2])
    for tensor in values.values():
        assert len(tensor["axes"]) == 7
        assert all(len(axis["ticks"]) == length for axis, length in zip(tensor["axes"], tensor["value"].shape))
        assert np.all(np.isfinite(tensor["value"]))


def test_native_endpoint_history_body_identity_and_all_axis_counts():
    model, state = make_model([box("first", [1, 2, 3]), transformed(box("second", [1, 1, 1]), [4, 0, 0])],
                              velocities=[[1, 2, 3], [-1, 0, 2]], omegas=[[.2, .3, .4], [1, 0, .5]])
    saved = saved_history(state)
    invocation = SimpleNamespace(
        config={"exports": [{"key": "snapshot", "methodId": "rigid.snapshot"}]},
        descriptor={"methods": {"exports": [{"methodId": "rigid.snapshot", "artifactType": "test.snapshot"}]},
                    "visualizations": {"motion": {"artifactType": "test.motion"}}},
    )
    exports, visualizations = build_native(invocation, model, saved)
    snapshot, visual = exports["snapshot"].members, visualizations["motion"].members
    np.testing.assert_array_equal(snapshot["times"]["value"], [.3])
    np.testing.assert_array_equal(snapshot["positions"]["value"][0], saved["position"])
    np.testing.assert_allclose(snapshot["angularVelocities"]["value"][0], [[.2, .3, .4], [1, 0, .5]])
    np.testing.assert_array_equal(visual["times"]["value"], [0, .2, .3])
    assert len(set(snapshot["bodyIds"]["value"])) == 2
    assert snapshot["bodyIds"]["value"].tolist() == list(model["bodyIds"])
    assert visual["vertexOffsets"]["value"][-1] == len(visual["vertices"]["value"])
    assert visual["triangleOffsets"]["value"][-1] == len(visual["triangles"]["value"])
    for bundle in (snapshot, visual):
        for member in bundle.values():
            assert len(member["axes"]) == member["value"].ndim
            assert all(axis.get("implicitOrdinal") or len(axis["ticks"]) == length
                       for axis, length in zip(member["axes"], member["value"].shape))
    # A final state already on the recorded lattice is not duplicated.
    saved["time"] = .2
    _, same_endpoint = build_native(invocation, model, saved)
    np.testing.assert_array_equal(same_endpoint["motion"].members["times"]["value"], [0, .2])
