"""Prepare reference stiffness, mass, damping and element data once per model."""

import numpy as np
from scipy import sparse

from ..beam import beam_matrices, truss_response
from ..constraints import spring_gradient
from ..continuum import element_matrices
from ..shells import shell4_mass_moments, shell4_matrices
from .prepared import PreparedStructuralOperators


def element_dofs(element):
    count = 6 if element.kind in ("beam2", "shell4") else 2 if element.kind in ("tri3", "quad4") else 3
    return (6 * element.nodes[:, None] + np.arange(count)).ravel()


def prepare_matrices(model):
    rows, columns, stiffness_values, mass_values, damping_values = [], [], [], [], []
    prepared = []
    for element in model.elements:
        points = model.points[element.nodes]
        material, section = element.material, element.section
        dofs = element_dofs(element)
        data = {"dofs": dofs}
        if element.kind == "beam2":
            length = np.linalg.norm(points[1] - points[0])
            local_K, local_M = beam_matrices(length, section["stiffness"], section["mass"])
            transform = np.kron(np.eye(4), section["frame"].T)
            K, M = transform.T @ local_K @ transform, transform.T @ local_M @ transform
            data.update(localK=local_K, localM=local_M, frame=section["frame"], length=length, sectionM=section["mass"])
            if np.any(section.get("damping", 0.0)):
                local_damping, _ = beam_matrices(length, section["damping"], np.zeros((6, 6)))
                data.update(localD=local_damping, D=transform.T @ local_damping @ transform)
        elif element.kind == "truss2":
            _, K, _ = truss_response(points, np.zeros((2, 3)), material["E"], section["area"])
            length = np.linalg.norm(points[1] - points[0])
            M = material["density"] * section["area"] * length / 6 * np.kron([[2, 1], [1, 2]], np.eye(3))
        elif element.kind == "shell4":
            K, M = shell4_matrices(points, section)
            normal, moments = shell4_mass_moments(points, section)
            data.update(normal=normal, massMoments=moments)
        else:
            coords = points[:, :2] if element.kind in ("tri3", "quad4") else points
            K, M = element_matrices(element.kind, coords, material["C"], material["density"], section.get("thickness", 1.0), section.get("plane", "stress"))
        data.update(K=K, M=M)
        prepared.append(data)
        rows.extend(np.repeat(dofs, len(dofs)))
        columns.extend(np.tile(dofs, len(dofs)))
        stiffness_values.extend(K.ravel())
        mass_values.extend(M.ravel())
        damping_values.extend(data.get("D", np.zeros_like(K)).ravel())
    shape = (model.size, model.size)
    stiffness = sparse.csr_matrix((stiffness_values, (rows, columns)), shape=shape)
    mass = sparse.csr_matrix((mass_values, (rows, columns)), shape=shape)
    damping = sparse.csr_matrix((damping_values, (rows, columns)), shape=shape).tolil()
    mass = mass.tolil()
    for node, weight, inertia in model.masses:
        indices = np.arange(6 * node, 6 * node + 6)
        block = np.zeros((6, 6))
        block[:3, :3] = np.eye(3) * weight
        block[3:, 3:] = inertia
        mass[np.ix_(indices, indices)] += block
    stiffness = stiffness.tolil()
    for a, b, ratio, spring, dashpot in model.springs:
        gradient = spring_gradient(model, np.tile(np.eye(3), (len(model.points), 1, 1)), a, b, ratio)
        dofs = np.flatnonzero(gradient)
        block = np.outer(gradient[dofs], gradient[dofs])
        stiffness[np.ix_(dofs, dofs)] += spring * block
        damping[np.ix_(dofs, dofs)] += dashpot * block
    batch = None
    beam_indices = [index for index, element in enumerate(model.elements) if element.kind == "beam2"]
    if len(beam_indices) > 1:
        # 해석 입력에서 한 번 준비하는 배치 배열입니다. checkpoint에는 넣지 않습니다.
        # 개별 prepared 요소도 보존하여 완전 접선/단일 요소 참조 경로를 유지합니다.
        batch = {"nodes": np.asarray([model.elements[index].nodes for index in beam_indices]), "frame": np.asarray([prepared[index]["frame"] for index in beam_indices])}
        batch["dofs"] = np.asarray([prepared[index]["dofs"] for index in beam_indices])
        batch["rows"] = np.repeat(batch["dofs"], 12, axis=1).ravel()
        batch["columns"] = np.tile(batch["dofs"], (1, 12)).ravel()
        for key in ("localK", "localM", "M", "localD", "D"):
            batch[key] = np.asarray([prepared[index].get(key, np.zeros((12, 12))) for index in beam_indices])
        for position, index in enumerate(beam_indices):
            prepared[index]["beamBatchIndex"] = position
    return PreparedStructuralOperators(stiffness.tocsr(), mass.tocsr(), damping.tocsr(), prepared, batch)
