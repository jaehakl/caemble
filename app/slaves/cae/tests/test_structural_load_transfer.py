"""수력 부가질량을 포함한 순간 외력의 합력·모멘트·가상일 전달 검증."""

from types import SimpleNamespace

import numpy as np
from app.kernel.api import BundleValue
from app.solvers.structural_mechanics.coupling import apply_resultant_loads
from app.solvers.structural_mechanics.model import StructuralModel


def test_detail_transfer_recovers_physical_fluid_force_and_preserves_virtual_work():
    target_points = np.array([[2.0, -1.0, 0.0], [2.0, 1.0, 0.0], [2.0, 0.0, 1.0]])
    source_points = np.array([[4.0, 0.5, 2.0], [6.0, -0.4, 3.0]])
    reference = np.array([2.0, 0.0, 0.0])
    model = StructuralModel(
        np.array([10, 11, 12]),
        target_points,
        [],
        np.arange(18),
        np.empty(0, dtype=int),
        np.zeros((3, 6)),
    )
    # 상세 모델 자체의 중력/구조 질량은 외력 전달 함수에 섞이지 않습니다.
    model.gravity = np.array([0.0, 0.0, -9.81])
    model.masses = [(0, 1e6, np.eye(3))]
    acceleration = np.array([[2.0, -1.0, 0.5], [-0.4, 0.3, 1.2]])
    added_mass = np.array(
        [
            [[4.0, 1.0, 0.0], [1.0, 3.0, 0.2], [0.0, 0.2, 2.0]],
            [[2.0, 0.0, 0.5], [0.0, 5.0, 0.0], [0.5, 0.0, 3.0]],
        ]
    )
    hydro_force = np.array([[11.0, 13.0, 17.0], [19.0, 23.0, 29.0]])
    aero_force = np.array([[3.0, 4.0, 5.0], [6.0, 7.0, 8.0]])
    aero_moment = np.array([[1.0, 2.0, 3.0], [-1.0, -2.0, -3.0]])
    coordinates = {
        "modelIdentity": "source-with-fluid",
        "nodeIds": np.array([5, 6]),
        "times": np.array([0.0, 1.0]),
    }
    motion = BundleValue(
        "caemble.mechanics/motion@1",
        {
            **coordinates,
            "positions": np.stack((source_points + 10.0, source_points)),
            "accelerations": np.stack((100.0 * acceleration, acceleration)),
        },
    )
    loads = []
    for force, moment, mass in (
        (hydro_force, np.zeros((2, 3)), added_mass),
        (aero_force, aero_moment, np.zeros_like(added_mass)),
    ):
        values = {
            **coordinates,
            "forces": np.stack((100.0 * force, force)),
            "moments": np.stack((100.0 * moment, moment)),
            "addedMass": mass.copy(),
        }
        for value in values.values():
            if isinstance(value, np.ndarray):
                value.flags.writeable = False
        loads.append(
            SimpleNamespace(value=BundleValue("caemble.mechanics/loads@1", values))
        )
    invocation = SimpleNamespace(
        inputs={"sourceLoads": loads, "sourceMotion": SimpleNamespace(value=motion)},
        config={
            "boundaryConditions": [
                {
                    "methodId": "fea.resultant-transfer",
                    "parameters": {
                        "sourceNodeIds": [5, 6],
                        "targetNodeIds": [10, 11, 12],
                        "referencePoint": reference,
                    },
                }
            ]
        },
    )
    apply_resultant_loads(invocation, model)
    # 독립 계산: 각 3×3 tensor를 가속도에 곱한다. 대각 성분만 곱하면 이 검사가 실패한다.
    physical = np.array(
        [
            hydro_force[node] + aero_force[node] - added_mass[node] @ acceleration[node]
            for node in range(2)
        ]
    )
    expected_force = physical.sum(axis=0)
    expected_moment = (aero_moment + np.cross(source_points - reference, physical)).sum(
        axis=0
    )
    np.testing.assert_allclose(
        model.force[:, :3].sum(axis=0), expected_force, atol=1e-12
    )
    np.testing.assert_allclose(
        np.cross(target_points - reference, model.force[:, :3]).sum(axis=0),
        expected_moment,
        atol=1e-12,
    )
    translation, rotation = np.array([0.02, 0.03, -0.04]), np.array([0.06, -0.02, 0.03])
    source_virtual_work = np.sum(
        physical * (translation + np.cross(rotation, source_points - reference))
    ) + np.sum(aero_moment * rotation)
    target_virtual_work = np.sum(
        model.force[:, :3]
        * (translation + np.cross(rotation, target_points - reference))
    )
    np.testing.assert_allclose(target_virtual_work, source_virtual_work, atol=1e-12)
    np.testing.assert_array_equal(loads[0].value.members["addedMass"], added_mass)
