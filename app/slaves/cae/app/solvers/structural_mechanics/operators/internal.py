"""Current internal force, tangent, trial material history and recoverable energy."""

import numpy as np
from scipy import sparse

from ..beam import beam_deformation, beam_response, truss_response
from ..constraints import contact_response, spring_gradient, spring_gradient_tangent
from ..continuum import element_nonlinear_response, element_response, tet4_corotational_response
from ..shells import shell4_response
from ..hyperelastic import tet4_response
from .prepared import _beam_batch
from ..thermal import thermal_element_response


def structural_response(model, displacement, orientations, prepared, committed, geometric=False, approximate_tangent=False):
    if prepared.thermal_batch is not None:
        from .thermal import thermal_batch_response
        return thermal_batch_response(model, displacement, prepared)
    force = np.zeros(model.size)
    rows, columns, values = [], [], []
    history, stresses = [], []
    energy = 0.0
    batch = _beam_batch(model, displacement, orientations, prepared) if geometric and approximate_tangent else None
    if batch is not None:
        batch_data, (deformations, frames, jacobians, _) = batch
        local_forces = (batch_data["localK"] @ deformations[..., None])[..., 0]
        batch_forces = (jacobians.transpose(0, 2, 1) @ local_forces[..., None])[..., 0]
        batch_tangents = jacobians.transpose(0, 2, 1) @ batch_data["localK"] @ jacobians
        batch_energy = .5 * np.einsum("ei,ei->e", deformations, local_forces)
        batch_local = (batch_forces.reshape(-1, 4, 3) @ frames).reshape(-1, 2, 6)
        np.add.at(force, batch_data["dofs"].ravel(), batch_forces.ravel())
        rows.append(batch_data["rows"])
        columns.append(batch_data["columns"])
        values.append(batch_tangents.ravel())
        energy = float(batch_energy.sum())
    for index, (element, data) in enumerate(zip(model.elements, prepared.element_data)):
        if batch is not None and element.kind == "beam2":
            local = batch_local[data["beamBatchIndex"]]
            history.append(None if committed is None else committed[index])
            stresses.append({"force": local[:, :3], "moment": local[:, 3:]})
            continue
        dofs = data["dofs"]
        values_u = displacement.ravel()[dofs]
        points = model.points[element.nodes]
        state = None if committed is None else committed[index]
        new_state, stress = state, None
        if model.thermal_strain is not None:
            tangent = data["K"]
            internal, stress, stored_energy = thermal_element_response(points, values_u, element.material["C"], model.thermal_strain[index])
        elif element.material["model"] == "mechanics.compressible-neo-hookean@1":
            if not geometric or element.kind != "tet4":
                raise ValueError("Neo-Hookean requires finite-deformation tet4 solids")
            internal, tangent, stored_energy, stress = tet4_response(
                displacement[element.nodes, :3], element.material, data, tangent=not approximate_tangent)
        elif geometric and element.kind == "beam2":
            internal, tangent, stored_energy = beam_response(points, displacement[element.nodes, :3], orientations[element.nodes], data["frame"], data["localK"], consistent_tangent=not approximate_tangent)
            current_frame = beam_deformation(points, displacement[element.nodes, :3], orientations[element.nodes], data["frame"])[1]
            local = (internal.reshape(4, 3) @ current_frame).reshape(2, 6)
            stress = {"force": local[:, :3], "moment": local[:, 3:]}
        elif geometric and element.kind == "truss2":
            internal, tangent, stored_energy = truss_response(points, displacement[element.nodes, :3], element.material["E"], element.section["area"])
        elif geometric and element.kind == "shell4":
            from ..corotation import shell_corotational_response
            internal, tangent, stored_energy, stress = shell_corotational_response(points, displacement[element.nodes, :3], orientations[element.nodes], element.section)
        elif geometric and element.kind == "tet4" and element.material["model"] != "mechanics.j2-plasticity@1":
            internal, tangent, stored_energy, stress = tet4_corotational_response(
                points, displacement[element.nodes, :3], element.material["C"],
                consistent_tangent=not approximate_tangent, reference_stiffness=data["K"],
            )
        elif element.material["model"] == "mechanics.j2-plasticity@1":
            if geometric:
                raise ValueError("solid J2 uses small strain; finite-strain J2 is not implemented")
            internal, tangent, new_state, stress = element_nonlinear_response(element.kind, points, values_u, element.material, state)
            # 소성 소산과 탄성 에너지를 같게 취급하지 않습니다. 회복 가능한
            # 탄성변형률의 일만 strain energy로 집계합니다.
            stored_energy = 0.0
            from ..continuum import integration_points
            for q, (_, B, weight, _) in enumerate(integration_points(element.kind, points)):
                elastic_strain = B @ values_u - new_state["plasticStrain"][q]
                stored_energy += 0.5 * elastic_strain @ stress[q] * weight
        else:
            if geometric and element.kind in ("hex8", "tri3", "quad4"):
                raise ValueError("finite geometry is supported for truss, beam, shell and tet4 blocks; other continuum blocks use small strain")
            tangent = data["K"]
            internal = tangent @ values_u
            stored_energy = float(values_u @ internal / 2)
            if element.kind == "shell4":
                stress = shell4_response(points, values_u, element.section)
            elif element.kind == "beam2":
                local = np.kron(np.eye(4), data["frame"].T) @ internal
                stress = {"force": local.reshape(2, 6)[:, :3], "moment": local.reshape(2, 6)[:, 3:]}
            elif element.kind != "truss2":
                coords = points[:, :2] if element.kind in ("tri3", "quad4") else points
                stress = element_response(element.kind, coords, values_u, element.material["C"], element.section.get("thickness", 1), element.section.get("plane", "stress"))[1]
        np.add.at(force, dofs, internal)
        rows.append(np.repeat(dofs, len(dofs)))
        columns.append(np.tile(dofs, len(dofs)))
        values.append(tangent.ravel())
        energy += stored_energy
        history.append(new_state)
        stresses.append(stress)
    spring_geometric = sparse.csr_matrix((model.size, model.size))
    for a, b, ratio, stiffness, _ in model.springs:
        extension = displacement.ravel()[a] - (ratio * displacement.ravel()[b] if b >= 0 else 0.)
        gradient = spring_gradient(model, orientations, a, b, ratio)
        force += stiffness * extension * gradient
        dofs = np.flatnonzero(gradient)
        rows.append(np.repeat(dofs, len(dofs)))
        columns.append(np.tile(dofs, len(dofs)))
        values.append((stiffness * np.outer(gradient[dofs], gradient[dofs])).ravel())
        if geometric:
            spring_geometric += stiffness * extension * spring_gradient_tangent(model, orientations, a, b, ratio)
        energy += stiffness * extension**2 / 2
    tangent = sparse.csr_matrix((np.concatenate(values), (np.concatenate(rows), np.concatenate(columns))), shape=(model.size, model.size)) + spring_geometric if rows else spring_geometric
    if model.contacts:
        contact_force, contact_tangent, active_contacts = contact_response(model.points, displacement, model.contacts)
        force += contact_force
        tangent += contact_tangent
        energy += sum(-0.5 * item["gap"] * item["normalForce"] for item in active_contacts)
    return force, tangent.tocsr(), history, stresses, float(energy)
