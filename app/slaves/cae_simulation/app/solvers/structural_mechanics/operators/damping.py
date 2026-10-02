"""Objective strain-rate damping and joint damping contributions."""

import numpy as np
from scipy import sparse

from ..beam import beam_kinematics
from ..constraints import spring_gradient
from ..continuum import tet4_corotational_response
from ..corotation import _perturbed_configuration, shell_deformation
from .prepared import _beam_batch


def strain_rate_damping(model, displacement, orientations, prepared, coefficient, geometric=False):
    """변형률 속도에 비례하는 감쇠 C(q)=beta J(q).T K_local J(q).

    beta의 단위는 s다. 국소 변형률이 변할 때만 에너지를 소산하므로 회전 중인
    무변형 블레이드를 가짜 브레이크로 멈추지 않는다. 기준 전역 K에 공간 속도를
    바로 곱하는 Rayleigh 감쇠는 큰 회전에서 이 객관성을 만족하지 않는다.
    질량 비례 감쇠와 명시적 조인트 댐퍼는 호출자가 별도로 더한다.
    """
    rows, columns, values = [], [], []
    joint_dampers = geometric and any(dashpot for _, _, _, _, dashpot in model.springs)
    if coefficient == 0 and not joint_dampers and (not geometric or not any("localD" in data for data in prepared.element_data)):
        return sparse.csr_matrix((model.size, model.size))
    batch = _beam_batch(model, displacement, orientations, prepared) if geometric else None
    if batch is not None:
        batch_data, (_, _, jacobians, _) = batch
        batch_damping = jacobians.transpose(0, 2, 1) @ (coefficient * batch_data["localK"] + batch_data["localD"]) @ jacobians - batch_data["D"]
        rows.append(batch_data["rows"])
        columns.append(batch_data["columns"])
        values.append(batch_damping.ravel())
    for element, data in zip(model.elements, prepared.element_data):
        if batch is not None and element.kind == "beam2":
            continue
        dofs = data["dofs"]
        nodes, points = element.nodes, model.points[element.nodes]
        if coefficient == 0 and "localD" not in data:
            continue
        if not geometric:
            block = data["K"]
        elif element.kind == "beam2":
            # 기준 단면 감쇠는 prepare_matrices의 C에 이미 있다. 현재 방향과의
            # 차이만 더해 이중 조립을 피한다. beta*K도 같은 객관적 경로다.
            jacobian = beam_kinematics(points, displacement[nodes, :3], orientations[nodes], data["frame"])[2]
            block = jacobian.T @ (coefficient * data["localK"] + data.get("localD", 0.0)) @ jacobian - data.get("D", 0.0)
        elif element.kind == "truss2":
            direction = points[1] + displacement[nodes[1], :3] - points[0] - displacement[nodes[0], :3]
            direction /= np.linalg.norm(direction)
            gradient = np.r_[-direction, direction]
            block = element.material["E"] * element.section["area"] / np.linalg.norm(points[1] - points[0]) * np.outer(gradient, gradient)
        elif element.kind == "shell4":
            jacobian = np.empty((24, 24))
            length = np.max(np.linalg.norm(points - points.mean(axis=0), axis=1))
            for column in range(24):
                step = 2e-6 * (length if column % 6 < 3 else 1.)
                plus = _perturbed_configuration(displacement[nodes, :3], orientations[nodes], column, step)
                minus = _perturbed_configuration(displacement[nodes, :3], orientations[nodes], column, -step)
                jacobian[:, column] = (shell_deformation(points, *plus) - shell_deformation(points, *minus)) / (2 * step)
            block = jacobian.T @ data["K"] @ jacobian
        elif element.kind == "tet4":
            block = tet4_corotational_response(
                points, displacement[nodes, :3], element.material["C"],
                consistent_tangent=False, reference_stiffness=data["K"],
            )[1]
        else:
            block = data["K"]
        rows.append(np.repeat(dofs, len(dofs)))
        columns.append(np.tile(dofs, len(dofs)))
        values.append((block if geometric and element.kind == "beam2" else coefficient * block).ravel())
    for a, b, ratio, stiffness, dashpot in model.springs:
        gradient = spring_gradient(model, orientations, a, b, ratio)
        reference = spring_gradient(model, np.tile(np.eye(3), (len(model.points), 1, 1)), a, b, ratio)
        dofs = np.union1d(np.flatnonzero(gradient), np.flatnonzero(reference))
        block = coefficient * stiffness * np.outer(gradient[dofs], gradient[dofs])
        if geometric:
            block += dashpot * (np.outer(gradient[dofs], gradient[dofs]) - np.outer(reference[dofs], reference[dofs]))
        rows.append(np.repeat(dofs, len(dofs)))
        columns.append(np.tile(dofs, len(dofs)))
        values.append(block.ravel())
    if not rows:
        return sparse.csr_matrix((model.size, model.size))
    return sparse.csr_matrix((np.concatenate(values), (np.concatenate(rows), np.concatenate(columns))), shape=(model.size, model.size))
