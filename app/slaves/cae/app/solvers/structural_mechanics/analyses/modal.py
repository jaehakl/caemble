"""Mass-normalized positive eigenmodes with sparse and exact small-system paths."""

import numpy as np
from scipy import linalg, sparse
from scipy.sparse.linalg import ArpackNoConvergence, eigsh

from ..constraints import constraint_transform
from ..numerics import _positive_sparse_mass


def _dense_modal_eigenpairs(stiffness, mass, count):
    """Small/mass-singular reference path, including shell drilling condensation."""
    K, M = stiffness.toarray(), mass.toarray()
    # 기울어진 shell의 drilling 무질량 방향은 xyz 중 어느 하나가 아닙니다.
    # 대각항만 검사하면 놓치므로 질량의 실제 영공간을 구해 축약합니다.
    diagonal = np.abs(np.diag(M))
    scaling = np.ones(len(M))
    scaling[diagonal > 0] = 1 / np.sqrt(diagonal[diagonal > 0])
    mass_values, mass_vectors = linalg.eigh(M * np.outer(scaling, scaling))
    mass_tolerance = max(np.max(np.abs(mass_values)), 1.) * 1e-12
    if np.min(mass_values) < -mass_tolerance:
        raise ValueError("modal mass matrix must be positive semidefinite")
    moving = mass_values > mass_tolerance
    if not np.any(moving):
        raise ValueError("modal analysis requires physical mass")
    S = np.eye(len(M)) if np.all(moving) else scaling[:, None] * mass_vectors[:, moving]
    null = scaling[:, None] * mass_vectors[:, ~moving]
    if null.shape[1]:
        S -= null @ linalg.solve(null.T @ K @ null, null.T @ K @ S, assume_a="sym")
    Kr, Mr = S.T @ K @ S, S.T @ M @ S
    if count < len(Kr) - 1:
        try:
            values, vectors = eigsh(sparse.csr_matrix(Kr), k=count, M=sparse.csr_matrix(Mr), sigma=0.0, which="LM", tol=1e-11)
        except RuntimeError:
            # 자유롭게 떠 있는 구조물은 여섯 강체 모드 때문에 K가 특이합니다.
            # 0 근처 shift-invert가 실패해도 질량 고유치 문제 자체는 유효합니다.
            values, vectors = linalg.eigh(Kr, Mr)
    else:
        values, vectors = linalg.eigh(Kr, Mr)
    # 일부 강체 모드만 계산된 경우 그 작은 고유치끼리 비교하면 부동소수점
    # 잡음을 진동 모드로 오인합니다. 실제 K/M의 주파수 척도도 함께 씁니다.
    zero_tolerance = max(np.max(np.abs(np.diag(Kr)) / np.diag(Mr)), np.max(np.abs(values), initial=0)) * 1e-12
    order = np.argsort(values)
    positive = order[values[order] > zero_tolerance]
    if len(positive) < count and len(values) < len(Kr):
        values, vectors = linalg.eigh(Kr, Mr)
        order = np.argsort(values)
        positive = order[values[order] > max(zero_tolerance, np.max(np.abs(values), initial=0) * 1e-12)]
    selected = positive[:count]
    if len(selected) < count:
        raise ValueError("requested more positive modes than the constrained model has")
    values, vectors = values[selected], vectors[:, selected]
    for value, vector in zip(values, vectors.T):
        physical = S @ vector
        residual = np.linalg.norm(K @ physical - value * M @ physical) / max(np.linalg.norm(K @ physical), 1e-30)
        if residual > 1e-8:
            raise ValueError("modal eigenpair did not meet the 1e-8 residual criterion")
    return values, S @ vectors


def _sparse_modal_eigenpairs(stiffness, mass, count):
    """Lowest positive modes without materializing the 3D volume matrices."""
    size = stiffness.shape[0]
    diagonal_mass = mass.diagonal()
    stiffness_scale = np.max(
        np.divide(np.abs(stiffness.diagonal()), diagonal_mass, out=np.zeros(size), where=diagonal_mass > 0),
        initial=1.,
    )
    zero_tolerance = stiffness_scale * 1e-12
    requested = min(size - 1, max(count + 8, 2 * count))
    while requested > 0:
        try:
            values, vectors = eigsh(
                stiffness, k=requested, M=mass,
                sigma=-max(stiffness_scale, 1.) * 1e-10,
                which="LM", tol=1e-10,
            )
        except (ArpackNoConvergence, RuntimeError, ValueError) as error:
            raise ValueError("sparse modal eigensolve failed; check mass and constraints") from error
        selected = np.flatnonzero(values > zero_tolerance)
        selected = selected[np.argsort(values[selected])][:count]
        if len(selected) == count:
            values, vectors = values[selected], vectors[:, selected]
            norms = np.sqrt(np.einsum("ij,ij->j", vectors, mass @ vectors))
            return values, vectors / norms
        if requested == size - 1:
            break
        requested = min(size - 1, max(requested + 8, requested * 2))
    raise ValueError("requested more positive modes than the constrained model has")


def modal_analysis(model, stiffness, mass, count):
    """Mass-normalized modes; generated solid models stay sparse.

    Small systems and the legacy shell drilling nullspace retain the exact dense
    condensation.  A positive-definite large mass matrix uses sparse
    shift-invert and explicitly skips rigid-body eigenvalues.
    """
    T = constraint_transform(model, np.tile(np.eye(3), (len(model.points), 1, 1)))
    stiffness, mass = ((T.T @ matrix @ T).tocsr() for matrix in (stiffness, mass))
    if stiffness.shape[0] == 0 or count < 1:
        raise ValueError("modal analysis requires free degrees of freedom and a positive mode count")
    use_dense = stiffness.shape[0] <= 128 or not _positive_sparse_mass(mass)
    values, vectors = (
        _dense_modal_eigenpairs(stiffness, mass, count)
        if use_dense else _sparse_modal_eigenpairs(stiffness, mass, count)
    )
    modes = np.asarray(T @ vectors).T.reshape(count, len(model.points), 6)
    return {"frequencies": np.sqrt(values) / (2 * np.pi), "modes": modes}
