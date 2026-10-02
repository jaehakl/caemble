"""Static equilibrium with accepted material history and support reactions."""

import numpy as np
from app.methods.continuum.hyperelastic import InvalidDeformationError

from ..constraints import constraint_transform, contact_response, revolute_joints, support_reactions
from ..kinematics import _link_geometric_matrix, apply_increment
from ..numerics import solve_linear
from ..operators.inertia import inertial_response
from ..operators.internal import structural_response
from app.methods.rigid.rotations import rotation_exp
from ..state import initial_solution
from ..loads import follower_pressure, update_follower_display
from ..solid_elements import SolidElements


def static_analysis(model, prepared, stiffness, mass, tolerance=1e-8, max_iterations=30, geometric=False, cancellation=None):
    """하중을 나누어 평형을 찾고, 편심 단면의 중력 모멘트도 현재 자세에서 푼다."""
    solution = initial_solution(model)
    gravity = np.zeros(model.size)
    gravity.reshape(-1, 6)[:, :3] = model.gravity
    external = model.force.ravel() + (mass @ gravity if prepared.thermal_batch is None else prepared.thermal_batch["body_force"])
    free_dofs = None if prepared.thermal_batch is None else prepared.thermal_batch.get("free_dofs")
    rotating_gravity = geometric and np.any(gravity)
    zero_motion = np.zeros_like(solution.displacement)
    displacement_driven = any(model.prescribed.values())
    materials = model.elements.materials if isinstance(model.elements, SolidElements) else (e.material for e in model.elements)
    nonlinear = geometric or bool(model.contacts) or any(material["model"] == "mechanics.j2-plasticity@1" for material in materials)
    if not nonlinear:
        T = constraint_transform(model, solution.orientations) if free_dofs is None else None
        for dof, value in model.prescribed.items():
            solution.displacement.ravel()[dof] = value
        applied = external if model.thermal_force is None else external + model.thermal_force
        if free_dofs is None:
            rhs = T.T @ (applied - stiffness @ solution.displacement.ravel())
            matrix = T.T @ stiffness @ T
        else:
            rhs = applied[free_dofs]
            prescribed_force = prepared.thermal_batch["prescribed_force"]
            if prescribed_force is not None:
                rhs = rhs - prescribed_force[free_dofs]
            matrix = prepared.thermal_batch["free_stiffness"]
        # The thermal solid matrix is symmetric. A symmetric graph ordering
        # limits sparse-factor fill in the very thin, conforming layered mesh.
        ordering = "COLAMD" if model.thermal_force is None else "MMD_AT_PLUS_A"
        modes = None
        block_size = 1
        if model.linear_solver == "cg-amg":
            positions = model.points - model.points.mean(axis=0)
            positions /= np.max(np.ptp(positions, axis=0))
            if not model.links:
                free = np.asarray(model.active)[~np.isin(model.active, model.fixed)]
                axes = np.eye(3)[free % 6]
                modes = np.column_stack((axes, np.cross(positions[free // 6], axes)))
            else:
                rigid = np.zeros((len(model.points), 6, 6))
                rigid[:, :3, :3] = np.eye(3)
                for axis in range(3):
                    rigid[:, :3, 3 + axis] = np.cross(np.eye(3)[axis], positions)
                modes = np.asarray(T.T @ rigid.reshape(model.size, 6))
            # Keep node translations together when elimination preserves complete
            # xyz blocks. Partial supports and rigid links retain scalar AMG.
            if not model.links:
                free = np.setdiff1d(model.active, model.fixed)
                if len(free) and len(free) % 3 == 0:
                    grouped = free.reshape(-1, 3)
                    if np.all(grouped[:, 0] % 6 == 0) and np.all(grouped == grouped[:, :1] + np.arange(3)):
                        block_size = 3
        if len(rhs):
            correction = solve_linear(matrix, rhs, ordering=ordering,
                positive_definite=model.thermal_force is not None, backend=model.linear_solver,
                near_nullspace=modes, block_size=block_size, tolerance=tolerance, cancellation=cancellation)
            if free_dofs is None:
                solution.displacement += np.asarray(T @ correction).reshape(-1, 6)
            else:
                solution.displacement.ravel()[free_dofs] += correction
        if model.thermal_force is None or np.any(solution.displacement[:, 3:]):
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
            for dof, value in model.prescribed.items():
                displacement.ravel()[dof] = target * value
            converged = False
            for iteration in range(max_iterations):
                if cancellation is not None:
                    cancellation.raise_if_cancelled()
                try:
                    internal, tangent, history, stress, energy = structural_response(model, displacement, rotations, prepared, solution.element_history, geometric)
                except InvalidDeformationError:
                    break
                current_external = target * external
                if rotating_gravity:
                    # 단면 무게중심이 기준선에서 벗어나면 M의 병진-회전 연결이
                    # 중력 모멘트를 만든다. 물체가 회전할 때 이 팔도 함께 돈다.
                    # v=0, a=g를 관성식에 넣으면 현재 M(q)g와 d(Mg)/dq를
                    # 같은 질량 정의에서 얻는다. 실제 관성 하중을 추가하는 것은 아니다.
                    weight, _, weight_tangent, _, _ = inertial_response(model, displacement, rotations, zero_motion, gravity.reshape(-1, 6), prepared, mass, geometric, derivatives=True)
                    current_external = target * (model.force.ravel() + weight)
                    tangent = tangent - target * weight_tangent
                if model.follower_pressures:
                    pressure_force, pressure_tangent = follower_pressure(model, displacement)
                    current_external += target * pressure_force
                    tangent -= target * pressure_tangent
                T = constraint_transform(model, rotations)
                residual = T.T @ (current_external - internal)
                force_scale = max(np.linalg.norm(T.T @ current_external), np.linalg.norm(internal) if displacement_driven else 0., 1.0)
                relative = np.linalg.norm(residual) / force_scale
                if relative <= tolerance:
                    converged = True
                    break
                tangent = tangent + _link_geometric_matrix(model, rotations, current_external - internal)
                correction = np.asarray(T @ solve_linear(T.T @ tangent @ T, residual))
                # 같은 확정 재료 이력에서 후보를 비교한다. 실패한 line-search는 버린다.
                for reduction in range(12):
                    candidate_u, candidate_R = apply_increment(model, displacement, rotations, correction * 0.5**reduction)
                    for dof, value in model.prescribed.items():
                        candidate_u.ravel()[dof] = target * value
                    try:
                        candidate_force = structural_response(model, candidate_u, candidate_R, prepared, solution.element_history, geometric, approximate_tangent=True)[0]
                    except InvalidDeformationError:
                        continue
                    candidate_external = target * external
                    if rotating_gravity:
                        weight = inertial_response(model, candidate_u, candidate_R, zero_motion, gravity.reshape(-1, 6), prepared, mass, geometric)[0]
                        candidate_external = target * (model.force.ravel() + weight)
                    if model.follower_pressures:
                        candidate_external += target * follower_pressure(model, candidate_u, tangent=False)[0]
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
    if model.follower_pressures:
        external += follower_pressure(model, solution.displacement, tangent=False)[0]
        update_follower_display(model, solution.displacement)
    solution.reaction = support_reactions(model, solution.orientations, internal - external)
    if free_dofs is None:
        T = constraint_transform(model, solution.orientations)
        projected_residual, projected_external = T.T @ (internal - external), T.T @ external
    else:
        projected_residual, projected_external = (internal - external)[free_dofs], external[free_dofs]
    solution.residual = float(np.linalg.norm(projected_residual) / max(np.linalg.norm(projected_external), np.linalg.norm(internal) if displacement_driven else 0., 1.0))
    if model.thermal_force is not None:
        projected_thermal = T.T @ model.thermal_force if free_dofs is None else model.thermal_force[free_dofs]
        elastic_force = None
        if displacement_driven:
            elastic_force = stiffness @ solution.displacement.ravel() if free_dofs is None else internal + model.thermal_force
        scale = max(np.linalg.norm(projected_external), np.linalg.norm(projected_thermal),
                    np.linalg.norm(elastic_force) if displacement_driven else 0., np.finfo(float).tiny)
        solution.residual = float(np.linalg.norm(projected_residual) / scale)
        if solution.residual > tolerance:
            raise ValueError(f"thermal structural relative residual {solution.residual:g} exceeds {tolerance:g}")
    solution.element_history, solution.stresses = history, stress
    solution.strain_energy = float(energy)
    solution.equilibrium_energy = float(energy)
    solution.contact_history = contact_response(model.points, solution.displacement, model.contacts)[2] if model.contacts else []
    return solution
