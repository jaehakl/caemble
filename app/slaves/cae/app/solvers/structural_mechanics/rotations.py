"""회전벡터와 회전행렬 사이의 작은 공용 수치 연산입니다.

누적 회전은 행렬 곱으로 합성합니다. 공간축의 증분 delta를 적용할 때는
``R_new = rotation_exp(delta) @ R_old``입니다. 회전벡터를 단순히 더하면
회전 순서에 따른 차이를 잃습니다.
"""

import numpy as np


def cross(a, b):
    """3차원 벡터 하나씩의 외적입니다. 배치 축 검사 비용 없이 식을 씁니다."""
    return np.array([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]])


def skew(vector: np.ndarray) -> np.ndarray:
    x, y, z = vector
    return np.array([[0., -z, y], [z, 0., -x], [-y, x, 0.]])


def skew_many(vectors):
    """여러 3차원 벡터의 외적 행렬을 한 NumPy 연산으로 만듭니다."""
    vectors = np.asarray(vectors)
    result = np.zeros((*vectors.shape[:-1], 3, 3))
    result[..., 0, 1], result[..., 0, 2] = -vectors[..., 2], vectors[..., 1]
    result[..., 1, 0], result[..., 1, 2] = vectors[..., 2], -vectors[..., 0]
    result[..., 2, 0], result[..., 2, 1] = -vectors[..., 1], vectors[..., 0]
    return result


def rotation_exp_many(vectors):
    """Rodrigues 공식의 배치 계산. 절점마다 같은 공식을 반복 호출하지 않습니다."""
    vectors = np.asarray(vectors)
    angles = np.linalg.norm(vectors, axis=-1)
    first, second = np.empty_like(angles), np.empty_like(angles)
    small = angles < 1e-7
    first[small], second[small] = 1 - angles[small]**2 / 6, .5 - angles[small]**2 / 24
    first[~small] = np.sin(angles[~small]) / angles[~small]
    second[~small] = (1 - np.cos(angles[~small])) / angles[~small]**2
    generators = skew_many(vectors)
    return np.eye(3) + first[..., None, None] * generators + second[..., None, None] * (generators @ generators)


def rotation_log_many(matrices):
    """주 회전벡터의 배치 계산. 드문 180도 근방은 검증된 단일 경로를 씁니다."""
    matrices = np.asarray(matrices)
    flat = matrices.reshape(-1, 3, 3)
    angles = np.arccos(np.clip((np.trace(flat, axis1=1, axis2=2) - 1) / 2, -1., 1.))
    axial = np.column_stack((flat[:, 2, 1] - flat[:, 1, 2], flat[:, 0, 2] - flat[:, 2, 0], flat[:, 1, 0] - flat[:, 0, 1]))
    scale = np.empty_like(angles)
    small, near_pi = angles < 1e-7, np.pi - angles < 1e-6
    normal = ~(small | near_pi)
    scale[small] = .5 + angles[small]**2 / 12
    scale[normal] = angles[normal] / (2 * np.sin(angles[normal]))
    scale[near_pi] = 0.
    result = scale[:, None] * axial
    for index in np.flatnonzero(near_pi):
        result[index] = rotation_log(flat[index])
    return result.reshape(*matrices.shape[:-2], 3)


def rotation_exp(vector: np.ndarray) -> np.ndarray:
    """Rodrigues 공식. 작은 각도에서는 상쇄 오차를 피하는 급수를 씁니다."""
    angle = np.linalg.norm(vector)
    cross = skew(vector)
    if angle < 1e-7:
        return np.eye(3) + (1 - angle**2 / 6) * cross + (0.5 - angle**2 / 24) * cross @ cross
    return np.eye(3) + np.sin(angle) / angle * cross + (1 - np.cos(angle)) / angle**2 * cross @ cross


def rotation_log(matrix: np.ndarray) -> np.ndarray:
    """주 회전벡터(-pi..pi). 180도 근처에서는 고유벡터로 회전축을 얻습니다."""
    cosine = np.clip((np.trace(matrix) - 1) / 2, -1., 1.)
    angle = np.arccos(cosine)
    axial = np.array([matrix[2, 1] - matrix[1, 2], matrix[0, 2] - matrix[2, 0], matrix[1, 0] - matrix[0, 1]])
    if angle < 1e-7:
        return (0.5 + angle**2 / 12) * axial
    if np.pi - angle < 1e-6:
        values, vectors = np.linalg.eigh((matrix + matrix.T) / 2)
        axis = vectors[:, np.argmax(values)]
        if axis @ axial < 0:
            axis = -axis
        return angle * axis
    return angle / (2 * np.sin(angle)) * axial
