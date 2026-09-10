"""명시적 메시 집합의 ID, 면 소속과 CAD 출처를 실제 공개 자원에서 확인한다."""

from copy import deepcopy
from types import SimpleNamespace

import numpy as np
import pytest

from app.kernel.catalog import solver_catalog
from app.kernel.resources import ResourceStore
from app.solvers.structural_mechanics.analysis import initial_solution
from app.solvers.structural_mechanics.domain import build_model
from app.solvers.structural_mechanics.outputs import build_outputs


def mesh_invocation():
    nodes = [11, 22, 33, 44, 55, 66, 77, 88]
    positions = [[0., 0., 0.], [1., 0., 0.], [1., 1., 0.], [0., 1., 0.], [0., 0., 1.], [1., 0., 1.], [1., 1., 1.], [0., 1., 1.]]
    config = {
        "parameters": {"analysis": "static", "geometricNonlinear": False},
        "initializations": [
            {"methodId": "fea.nodes", "parameters": {"nodeIds": nodes, "positions": positions}},
            # 집합이 요소보다 먼저 선언되어도 최종 메시에서 소속을 검증한다.
            {"methodId": "fea.node-set", "target": ["experiment.geometry.solid"], "parameters": {"name": "selected", "nodeIds": [77, 11, 44]}},
            {"methodId": "fea.face-set", "target": ["experiment.geometry.shell"], "parameters": {"name": "selected", "kind": "quad4", "faces": [[44, 33, 22, 11]]}},
            {"methodId": "fea.face-set", "target": ["experiment.geometry.tetra"], "parameters": {"name": "triangle", "kind": "tri3", "faces": [[55, 22, 11]]}},
            {"methodId": "fea.hex8", "target": ["experiment.geometry.solid"], "parameters": {"connectivity": [nodes]}},
            {"methodId": "fea.shell4", "target": ["experiment.geometry.shell"], "parameters": {"connectivity": [nodes[:4]], "thickness": .1}},
            {"methodId": "fea.tet4", "target": ["experiment.geometry.tetra"], "parameters": {"connectivity": [[11, 22, 44, 55]]}},
        ],
        "boundaryConditions": [],
        "outputs": [{"methodId": "fea.displacement", "key": "displacement", "parameters": {}}],
    }
    world = {
        "experiment": {
            "geometryHash": "immutable-cad-version",
            "geometryGroups": [{"name": name, "rootIds": [name + "-root"]} for name in ("solid", "shell", "tetra")],
            "roots": [{"id": name + "-root", "material": {"name": "Steel"}} for name in ("solid", "shell", "tetra")],
        },
        "materialSelections": {role: {"Steel": {"constitutive": "elastic"}} for role in ("hexDomain", "shellDomain", "tetDomain")},
        "materials": {"experiment": {"Steel": {"models": {"elastic": {"model": "mechanics.isotropic-elastic@1", "parameters": {"E": 1000., "nu": .3, "density": 1.}}}}}},
    }
    return SimpleNamespace(config=config, world=world)


def test_named_sets_survive_field_resource_roundtrip_with_original_ids_and_cad_provenance():
    invocation = mesh_invocation()
    model = build_model(invocation)
    field = build_outputs(invocation.config, solver_catalog.descriptor("structural-mechanics", "1.0.0"), model, initial_solution(model))["displacement"]
    resources = ResourceStore()
    try:
        restored = resources.resolve(resources.ingest(field))
        metadata = restored.domain.metadata
        np.testing.assert_array_equal(metadata["nodeIds"], [11, 22, 33, 44, 55, 66, 77, 88])
        node = metadata["nodeSets"]["selected"]
        quad = metadata["faceSets"]["selected"]
        triangle = metadata["faceSets"]["triangle"]
        np.testing.assert_array_equal(node["nodeIds"], [77, 11, 44])
        np.testing.assert_array_equal(quad["faces"], [[44, 33, 22, 11]])
        np.testing.assert_array_equal(triangle["faces"], [[55, 22, 11]])
        assert quad["kind"] == "quad4" and triangle["kind"] == "tri3"
        for entry, root in ((node, "solid"), (quad, "shell"), (triangle, "tetra")):
            assert entry["source"] == "experiment"
            assert entry["rootId"] == root + "-root"
            assert list(entry["target"]) == ["experiment.geometry." + root]
            assert entry["geometryHash"] == "immutable-cad-version"
        assert node["nodeIds"].dtype == np.int32 and quad["faces"].dtype == np.int32
    finally:
        resources.close()
    # 이름도 checkpoint 식별의 일부이며 집합이 없는 모델의 물리 배열은 그대로다.
    changed = deepcopy(invocation)
    changed.config["initializations"][1]["parameters"]["name"] = "renamed"
    assert build_model(changed).identity != model.identity
    changed.config["initializations"] = [rule for rule in changed.config["initializations"] if rule["methodId"] not in ("fea.node-set", "fea.face-set")]
    plain = build_model(changed)
    np.testing.assert_array_equal(model.active, plain.active)
    np.testing.assert_array_equal(model.force, plain.force)


@pytest.mark.parametrize("index,changes,message", [
    (1, {"name": " "}, "nonempty name"),
    (1, {"nodeIds": [11, 11]}, "unique IDs"),
    (1, {"nodeIds": [11, 999]}, "absent"),
    (1, {"nodeIds": [11., 22.]}, "int32"),
    (2, {"kind": "tri3"}, "matching arity"),
    (2, {"faces": [[11, 22, 33, 11]]}, "distinct vertices"),
    (2, {"faces": [[11, 22, 33, 44], [44, 33, 22, 11]]}, "no repeated faces"),
    (2, {"faces": [[11, 22, 33, 999]]}, "absent"),
    (2, {"faces": [[55, 66, 77, 88]]}, "target CAD root"),
    (2, {"faces": [[11, 22, 55, 77]]}, "actual element face"),
])
def test_named_sets_reject_ambiguous_or_invalid_connectivity(index, changes, message):
    invocation = mesh_invocation()
    invocation.config["initializations"][index]["parameters"].update(changes)
    with pytest.raises(ValueError, match=message):
        build_model(invocation)


def test_repeated_set_initializations_require_unique_names_within_each_kind():
    invocation = mesh_invocation()
    invocation.config["initializations"].append(deepcopy(invocation.config["initializations"][1]))
    with pytest.raises(ValueError, match="unique within their kind"):
        build_model(invocation)
