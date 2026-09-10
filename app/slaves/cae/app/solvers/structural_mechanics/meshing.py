"""작은 명시적 메시 생성기. CAD 삼각형을 체적 요소로 오인하지 않는다.

반환값은 좌표와 연결정보뿐이다. 재료/구속/해석기는 메시가 어떤 경로에서
왔는지 알 필요가 없다. 향후 CAD mesher도 같은 입력 경계에 연결한다.
"""

import numpy as np


def line_mesh(start, end, divisions):
    if divisions < 1:
        raise ValueError("line divisions must be positive")
    points = np.linspace(start, end, divisions + 1)
    return points, np.column_stack((np.arange(divisions), np.arange(1, divisions + 1)))


def plate_mesh(origin, size, divisions):
    nx, ny = map(int, divisions)
    if min(nx, ny) < 1:
        raise ValueError("plate divisions must be positive")
    points = np.array([[x, y, 0.0] for y in np.linspace(0, size[1], ny + 1) for x in np.linspace(0, size[0], nx + 1)]) + origin
    cells = [[j * (nx + 1) + i, j * (nx + 1) + i + 1, (j + 1) * (nx + 1) + i + 1, (j + 1) * (nx + 1) + i] for j in range(ny) for i in range(nx)]
    return points, np.asarray(cells, dtype=np.int64)


def cylinder_mesh(origin, radius, height, divisions):
    """z축 원통 중간면. 외표면에서 두께를 임의로 추정하지 않는다."""
    nt, nz = map(int, divisions)
    if nt < 3 or nz < 1 or min(radius, height) <= 0:
        raise ValueError("cylinder needs positive size and at least 3 circumferential cells")
    points = np.array([[radius * np.cos(t), radius * np.sin(t), z] for z in np.linspace(0, height, nz + 1) for t in np.linspace(0, 2 * np.pi, nt, endpoint=False)]) + origin
    cells = [[j * nt + i, j * nt + (i + 1) % nt, (j + 1) * nt + (i + 1) % nt, (j + 1) * nt + i] for j in range(nz) for i in range(nt)]
    return points, np.asarray(cells, dtype=np.int64)


def brick_mesh(origin, size, divisions):
    nx, ny, nz = map(int, divisions)
    if min(nx, ny, nz) < 1:
        raise ValueError("brick divisions must be positive")
    points = np.array([[x, y, z] for z in np.linspace(0, size[2], nz + 1) for y in np.linspace(0, size[1], ny + 1) for x in np.linspace(0, size[0], nx + 1)]) + origin
    stride = (nx + 1) * (ny + 1)
    cells = []
    for k in range(nz):
        for j in range(ny):
            for i in range(nx):
                a = k * stride + j * (nx + 1) + i
                cells.append([a, a + 1, a + nx + 2, a + nx + 1, a + stride, a + stride + 1, a + stride + nx + 2, a + stride + nx + 1])
    return points, np.asarray(cells, dtype=np.int64)
