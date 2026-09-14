"""Static equilibrium with accepted material history and support reactions."""

import numpy as np

from ..constraints import constraint_transform, contact_response, revolute_joints, support_reactions
from ..kinematics import _link_geometric_matrix, apply_increment
from ..numerics import solve_linear
from ..operators.inertia import inertial_response
from ..operators.internal import structural_response
from app.methods.rigid.rotations import rotation_exp
from ..state import initial_solution


def static_analysis(model, prepared, stiffness, mass, tolerance=1e-8, max_iterations=30, geometric=False, cancellation=None):
    """하중을 나누어 평형을 찾고, 편심 단면의 중력 모멘트도 현재 자세에서 푼다."""
    solution = initial_solution(model)
    gravity = np.zeros(model.size)
    gravity.reshape(-1, 6)[:, :3] = model.gravity
    external = model.force.ravel() + mass @ gravity
    rotating_gravity = geometric and np.any(gravity)
    zero_motion = np.zeros_like(solution.displacement)
    nonlinear = geometric or bool(model.contacts) or any(e.material["model"] == "mechanics.j2-plasticity@1" for e in model.elements)
    if not nonlinear:
        T = constraint_transform(model, solution.orientations)
        solution.displacement = np.asarray(T @ solve_linear(T.T @ stiffness @ T, T.T @ external)).reshape(-1, 6)
        solution.orientations = np.asarray([rotation_exp(value[3:]) for value in solution.displacement])
        for slave, (master, axis_index) in revolute_joints(model).items():
            solution.displacement[slave, 3 + axis_index] -= solution.displacement[master, 3 + axis_index]
        solution.iterations = 1
        internal, _, history, stress, energy = structural_response(model, solution.displacement, solution.orientations, prepared, None)
    else:
        factor, increment = 0.0, 0.25
        while factor < 1.0 - 1e-12:
            target = min(1.0, factor + increment)
            displacement, rotations = solution.displacement.copy(), solution.orientations.copy()
            converged = False
            for iteration in range(max_iterations):
                if cancellation is not None:
                    cancellation.raise_if_cancelled()
                internal, tangent, history, stress, energy = structural_response(model, displacement, rotations, prepared, solution.element_history, geometric)
                current_external = target * external
                if rotating_gravity:
                    # 단면 무게중심이 기준선에서 벗어나면 M의 병진-회전 연결이
                    # 중력 모멘트를 만든다. 물체가 회전할 때 이 팔도 함께 돈다.
                    # v=0, a=g를 관성식에 넣으면 현재 M(q)g와 d(Mg)/dq를
                    # 같은 질량 정의에서 얻는다. 실제 관성 하중을 추가하는 것은 아니다.
                    weight, _, weight_tangent, _, _ = inertial_response(model, displacement, rotations, zero_motion, gravity.reshape(-1, 6), prepared, mass, geometric, derivatives=True)
                    current_external = target * (model.force.ravel() + weight)
                    tangent = tangent - target * weight_tangent
                T = constraint_transform(model, rotations)
                residual = T.T @ (current_external - internal)
                relative = np.linalg.norm(residual) / max(np.linalg.norm(T.T @ current_external), 1.0)
                if relative <= tolerance:
                    converged = True
                    break
                tangent = tangent + _link_geometric_matrix(model, rotations, current_external - internal)
                correction = np.asarray(T @ solve_linear(T.T @ tangent @ T, residual))
                # 같은 확정 재료 이력에서 후보를 비교한다. 실패한 line-search는 버린다.
                for reduction in range(12):
                    candidate_u, candidate_R = apply_increment(model, displacement, rotations, correction * 0.5**reduction)
                    candidate_force = structural_response(model, candidate_u, candidate_R, prepared, solution.element_history, geometric, approximate_tangent=True)[0]
                    candidate_external = target * external
                    if rotating_gravity:
                        weight = inertial_response(model, candidate_u, candidate_R, zero_motion, gravity.reshape(-1, 6), prepared, mass, geometric)[0]
                        candidate_external = target * (model.force.ravel() + weight)
                    candidate_residual = candidate_external - candidate_force
                    # 가는 보는 축/굽힘 강성 차이가 큽니다. 원시 힘의 norm만
                    # 줄이면 유효한 굽힘 Newton 증분을 지나치게 잘라 버립니다.
                    # 일(work)에 해당하는 방향 잔차로 backtracking합니다.
                    if abs(correction @ candidate_residual) < abs(correction @ (current_external - internal)):
                        displacement, rotations = candidate_u, candidate_R
                        break
                else:
                    break
            if not converged:
                increment /= 2
                if increment < 1e-6:
                    raise ValueError("nonlinear equilibrium did not converge after load-step reduction")
                continue
            solution.displacement, solution.orientations = displacement, rotations
            solution.element_history = history
            solution.iterations += iteration + 1
            factor = target
            increment = min(2 * increment, 1.0 - factor)
    if rotating_gravity:
        weight = inertial_response(model, solution.displacement, solution.orientations, zero_motion, gravity.reshape(-1, 6), prepared, mass, geometric)[0]
        external = model.force.ravel() + weight
    solution.reaction = support_reactions(model, solution.orientations, internal - external)
    T = constraint_transform(model, solution.orientations)
    solution.residual = float(np.linalg.norm(T.T @ (internal - external)) / max(np.linalg.norm(T.T @ external), 1.0))
    solution.element_history, solution.stresses = history, stress
    solution.strain_energy = float(energy)
    solution.contact_history = contact_response(model.points, solution.displacement, model.contacts)[2] if model.contacts else []
    return solution
