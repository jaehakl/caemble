"""표시가 같은 물성의 checkpoint 혼용 방지와 요소 블록 CAD 출처 보존."""

import hashlib
from copy import deepcopy
from types import SimpleNamespace

import numpy as np
import pytest

from app.kernel.catalog import solver_catalog
from app.kernel.resources import ResourceStore
from app.solvers.structural_mechanics.analysis import initial_solution
from app.solvers.structural_mechanics.constraints import constraint_transform
from app.solvers.structural_mechanics.domain import update_fingerprint
from tests.structural_fixture import build_model
from app.solvers.structural_mechanics.outputs import _physical_domain
from app.solvers.structural_mechanics.state import encode_state, read_state


def generalized_beam_invocation():
    config = {
        "parameters": {"analysis": "transient", "geometricNonlinear": True},
        "initializations": [
            {"methodId": "fea.nodes", "parameters": {"nodeIds": np.array([11, 22]), "positions": np.array([[0., 0., 0.], [1., 0., 0.]])}},
            {"methodId": "fea.generalized-beam2", "target": ["experiment.geometry.beam"], "parameters": {
                "connectivity": np.array([[11, 22]]), "orientation": np.array([0., 1., 0.]),
                "stiffnessForce": np.eye(3) * 1e9, "stiffnessCoupling": np.zeros((3, 3)), "stiffnessMoment": np.eye(3) * 1e6,
                "massTranslation": np.eye(3) * 2., "massCoupling": np.zeros((3, 3)), "massRotation": np.eye(3) * .2,
            }},
        ],
        "boundaryConditions": [{"methodId": "fea.fixed", "parameters": {"nodeIds": [11], "components": list(range(6))}}],
        "outputs": [{"methodId": "fea.displacement", "key": "displacement", "parameters": {}}],
    }
    world = {
        "experiment": {"geometryHash": "canonical-cad-hash", "geometryGroups": [{"name": "beam", "rootIds": ["beam-root"]}], "roots": [{"id": "beam-root", "material": {"name": "Steel"}}]},
        "materialSelections": {"generalizedBeamDomain": {"Steel": {"constitutive": "solid"}}},
        "materials": {"experiment": {"Steel": {"models": {"solid": {"model": "mechanics.isotropic-elastic@1", "parameters": {"E": 210e9, "nu": .3, "density": 7850.}}}}}},
    }
    return SimpleNamespace(config=config, world=world)


@pytest.mark.parametrize("analysis", ["static", "transient", "modal", "harmonic"])
def test_physical_mass_guard_applies_to_finite_rotation_analysis_only(analysis):
    invocation = generalized_beam_invocation()
    invocation.config["parameters"]["analysis"] = analysis
    mass = invocation.config["initializations"][1]["parameters"]["massTranslation"]
    mass[0, 0] = 2.1  # SPD이지만 실제 구조 질량의 mI는 아니다.
    if analysis in ("static", "transient"):
        with pytest.raises(ValueError, match="mass translation"):
            build_model(invocation)
    else:
        # 모달/조화응답은 geometricNonlinear=True여도 기준 선형 문제다.
        model = build_model(invocation)
        np.testing.assert_array_equal(model.elements[0].section["mass"][:3, :3], mass)


def test_same_printed_section_cannot_reuse_a_physically_different_checkpoint():
    first = generalized_beam_invocation()
    second = deepcopy(first)
    second.config["initializations"][1]["parameters"]["stiffnessForce"][0, 0] += 1.
    # 1e9 N에서 1 N의 차이는 기본 8자리 표시에서 사라져도 서로 다른 모델입니다.
    with np.printoptions(precision=8, threshold=1000):
        assert repr(first.config) == repr(second.config)
        original = build_model(first)
        changed = build_model(second)
        assert repr(original.elements[0].section) == repr(changed.elements[0].section)
    assert original.elements[0].section["stiffness"][0, 0] != changed.elements[0].section["stiffness"][0, 0]
    checkpoint = encode_state(original, initial_solution(original))
    with pytest.raises(ValueError, match="different mesh/material/constraint/integration model"):
        read_state(changed, checkpoint)


def test_identity_does_not_depend_on_print_options_mapping_order_or_array_layout():
    invocation = generalized_beam_invocation()
    original = build_model(invocation)
    reordered = deepcopy(invocation)
    reordered.config = dict(reversed(list(reordered.config.items())))
    section = reordered.config["initializations"][1]["parameters"]
    section["stiffnessForce"] = np.asfortranarray(section["stiffnessForce"].astype(">f8"))
    with np.printoptions(precision=2, threshold=1):
        same = build_model(reordered)
    assert same.identity == original.identity
    read_state(same, encode_state(original, initial_solution(original)))


def test_each_element_block_retains_cad_target_and_ids_in_public_mesh_metadata():
    invocation = generalized_beam_invocation()
    invocation.config["initializations"].append(deepcopy(invocation.config["initializations"][1]))
    model = build_model(invocation)
    descriptor = solver_catalog.descriptor("structural-mechanics", "5.0.0")
    domain, _ = _physical_domain(model)
    resources = ResourceStore()
    try:
        restored = resources.resolve(resources.ingest(domain))
        provenance = restored.metadata["provenance"]
        assert provenance["experiment"] == "canonical-cad-hash"
        blocks = provenance["elementBlocks"]
        assert len(blocks) == 2
        for index, block in enumerate(blocks):
            assert block["methodId"] == "fea.generalized-beam2"
            assert list(block["target"]) == ["experiment.geometry.beam"]
            assert block["rootId"] == "beam-root"
            assert block["cellType"] == "beam2"
            np.testing.assert_array_equal(block["elementIds"], [index])
    finally:
        resources.close()


def test_bulk_numeric_sequence_hash_preserves_hidden_values_types_and_boundaries():
    # 4096개 중간 값은 ndarray repr에서 생략된다. 한 bit의 물리 계수 차이도 보존한다.
    values = np.linspace(0., 1., 4096).tolist()
    changed = values.copy()
    changed[2048] = np.nextafter(changed[2048], np.inf).item()
    cases = [values, changed, [1, 2.], [1., 2.], [True, 2.], [[1, 2], [3]], [[1], [2, 3]], ["1", 2.], np.array([1., 2.])]
    identities = []
    for value in cases:
        digest = hashlib.sha256()
        update_fingerprint(digest, value)
        identities.append(digest.hexdigest())
    assert len(set(identities)) == len(cases)
    # 이진 목록 포장은 별칭 공유 여부에 의존하지 않으며 tuple/list 의미를 유지한다.
    shared = [1., 2.]
    first, second = hashlib.sha256(), hashlib.sha256()
    update_fingerprint(first, [shared, shared])
    update_fingerprint(second, ((1., 2.), (1., 2.)))
    assert first.hexdigest() == second.hexdigest()


@pytest.mark.parametrize("connection,component,accepted", [
    ("free", 3, False),
    ("fixed-axis", 3, True),
    ("revolute", 3, True),
    ("revolute", 4, False),
    ("rigid", 3, False),
    ("linear", 3, True),
    ("damper", 3, True),
])
def test_rotation_spring_requires_a_physical_scalar_angle_in_finite_rotation(connection, component, accepted):
    invocation = generalized_beam_invocation()
    rules = invocation.config["initializations"]
    rules.append({"methodId": "fea.rotation-spring", "parameters": {"nodeA": 22, "dofA": component, "nodeB": -1, "dofB": 3, "ratio": 1., "stiffness": 0. if connection == "damper" else 10., "damping": 1.}})
    if connection == "fixed-axis":
        invocation.config["boundaryConditions"].append({"methodId": "fea.fixed", "parameters": {"nodeIds": [22], "components": [4, 5]}})
    elif connection in ("revolute", "rigid"):
        rules.append({"methodId": "fea.rigid-link", "parameters": {"master": 11, "slave": 22, "components": [0, 1, 2, 4, 5] if connection == "revolute" else list(range(6))}})
    elif connection == "linear":
        invocation.config["parameters"]["geometricNonlinear"] = False
    if accepted:
        assert len(build_model(invocation).springs) == 1
    else:
        with pytest.raises(ValueError, match="finite-rotation spring requires"):
            build_model(invocation)


@pytest.mark.parametrize("components,geometric,accepted", [
    ([0], True, True), ([0, 1, 2], True, True), ([3, 4, 5], True, True),
    ([0, 1, 2, 3, 4, 5], True, True), ([0, 1, 2, 4, 5], True, True),
    ([3], True, False), ([0, 1, 2, 3], True, False), ([0, 1, 4, 5], True, False),
    ([3], False, True),
])
def test_finite_rotation_links_reject_undefined_partial_attitude_constraints(components, geometric, accepted):
    invocation = generalized_beam_invocation()
    invocation.config["parameters"]["geometricNonlinear"] = geometric
    invocation.config["initializations"].append({"methodId": "fea.rigid-link", "parameters": {"master": 11, "slave": 22, "components": components}})
    if accepted:
        assert len(build_model(invocation).links) == 1
    else:
        with pytest.raises(ValueError, match="finite-rotation rigid-link requires"):
            build_model(invocation)


@pytest.mark.parametrize("geometric", [False, True])
def test_fixed_slave_cannot_silently_conflict_with_a_free_spring_supported_master(geometric):
    invocation = generalized_beam_invocation()
    invocation.config["parameters"]["geometricNonlinear"] = geometric
    invocation.config["initializations"].extend([
        {"methodId": "fea.rigid-link", "parameters": {"master": 11, "slave": 22, "components": [0]}},
        {"methodId": "fea.translation-spring", "parameters": {"nodeA": 11, "dofA": 0, "nodeB": -1, "dofB": 0, "ratio": 1., "stiffness": 100., "damping": 0.}},
    ])
    # x_slave=x_master인 축방향 tie에서 slave만 0으로 고정하면 master도
    # 고정되어야 한다. 이 전파를 구현하지 않은 채 자유 master를 풀면 모순이다.
    invocation.config["boundaryConditions"] = [{"methodId": "fea.fixed", "parameters": {"nodeIds": [22], "components": [0]}}]
    with pytest.raises(ValueError, match="fixed support cannot target a rigid-link dependent DOF"):
        build_model(invocation)
    invocation.config["boundaryConditions"][0]["parameters"]["nodeIds"] = [11]
    model = build_model(invocation)
    transform = constraint_transform(model, np.tile(np.eye(3), (2, 1, 1)))
    np.testing.assert_array_equal(transform.toarray()[[0, 6]], 0.)


def test_a_revolute_joint_can_lock_its_independent_relative_angle():
    invocation = generalized_beam_invocation()
    invocation.config["initializations"].append({"methodId": "fea.rigid-link", "parameters": {"master": 11, "slave": 22, "components": [0, 1, 2, 4, 5]}})
    invocation.config["boundaryConditions"].append({"methodId": "fea.fixed", "parameters": {"nodeIds": [22], "components": [3]}})
    model = build_model(invocation)
    assert 9 in model.fixed
