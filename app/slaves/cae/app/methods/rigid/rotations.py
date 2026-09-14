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


def normalize_quaternion(quaternion):
    """Normalize wxyz quaternions without choosing a different hemisphere."""
    values = np.asarray(quaternion, dtype=np.float64)
    lengths = np.linalg.norm(values, axis=-1, keepdims=True)
    if np.any(~np.isfinite(lengths)) or np.any(lengths == 0):
        raise ValueError("orientation must be a finite nonzero quaternion")
    return values / lengths


def quaternion_multiply(left, right):
    """Compose body-to-world rotations: left is the world-frame increment."""
    left, right = np.asarray(left, dtype=np.float64), np.asarray(right, dtype=np.float64)
    scalar = left[..., :1] * right[..., :1] - np.sum(left[..., 1:] * right[..., 1:], axis=-1, keepdims=True)
    vector = left[..., :1] * right[..., 1:] + right[..., :1] * left[..., 1:] + np.cross(left[..., 1:], right[..., 1:])
    return np.concatenate((scalar, vector), axis=-1)


def quaternion_exp(rotation_vectors):
    """Map full-angle rotation vectors to wxyz quaternions, preserving turns."""
    vectors = np.asarray(rotation_vectors, dtype=np.float64)
    half_angles = np.linalg.norm(vectors, axis=-1, keepdims=True) / 2
    scale = .5 * np.sinc(half_angles / np.pi)
    return np.concatenate((np.cos(half_angles), scale * vectors), axis=-1)


def quaternion_to_matrix(quaternion):
    """Return body-local to world matrices for a broadcast batch of wxyz values."""
    values = normalize_quaternion(quaternion)
    w, x, y, z = np.moveaxis(values, -1, 0)
    result = np.empty((*values.shape[:-1], 3, 3), dtype=np.float64)
    result[..., 0, 0], result[..., 0, 1], result[..., 0, 2] = 1 - 2 * (y*y + z*z), 2 * (x*y - w*z), 2 * (x*z + w*y)
    result[..., 1, 0], result[..., 1, 1], result[..., 1, 2] = 2 * (x*y + w*z), 1 - 2 * (x*x + z*z), 2 * (y*z - w*x)
    result[..., 2, 0], result[..., 2, 1], result[..., 2, 2] = 2 * (x*z - w*y), 2 * (y*z + w*x), 1 - 2 * (x*x + y*y)
    return result


def quaternion_from_matrix(matrices):
    """Convert SO(3) matrices in batches, including rotations near pi."""
    matrices = np.asarray(matrices, dtype=np.float64)
    trace = np.trace(matrices, axis1=-2, axis2=-1)
    diagonal = np.diagonal(matrices, axis1=-2, axis2=-1)
    squared = np.concatenate(((1 + trace)[..., None], 1 + 2 * diagonal - trace[..., None]), axis=-1)
    candidates = np.empty((*matrices.shape[:-2], 4, 4), dtype=np.float64)
    candidates[..., 0, :] = np.stack((squared[..., 0], matrices[..., 2, 1] - matrices[..., 1, 2], matrices[..., 0, 2] - matrices[..., 2, 0], matrices[..., 1, 0] - matrices[..., 0, 1]), axis=-1)
    candidates[..., 1, :] = np.stack((candidates[..., 0, 1], squared[..., 1], matrices[..., 0, 1] + matrices[..., 1, 0], matrices[..., 0, 2] + matrices[..., 2, 0]), axis=-1)
    candidates[..., 2, :] = np.stack((candidates[..., 0, 2], candidates[..., 1, 2], squared[..., 2], matrices[..., 1, 2] + matrices[..., 2, 1]), axis=-1)
    candidates[..., 3, :] = np.stack((candidates[..., 0, 3], candidates[..., 1, 3], candidates[..., 2, 3], squared[..., 3]), axis=-1)
    largest = np.argmax(squared, axis=-1)
    selected = np.take_along_axis(candidates, largest[..., None, None], axis=-2)[..., 0, :]
    return normalize_quaternion(selected)
