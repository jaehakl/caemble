"""CAD 표면, 해석 요소, 계산 자유도를 구분하는 작은 값 객체들.

절점 운동은 읽기 편하게 [ux, uy, uz, rx, ry, rz] 순서로 보관한다.
행렬에는 실제 요소/연결이 사용하는 자유도만 넣는다. 따라서 솔리드의
사용하지 않는 회전 자유도 때문에 0인 행/열이 생기지 않는다.
"""

from dataclasses import dataclass, field
from typing import Any

import numpy as np


@dataclass
class Element:
    kind: str
    nodes: np.ndarray
    material: dict[str, Any]
    section: dict[str, Any] = field(default_factory=dict)
    root_id: str = ""


@dataclass
class StructuralModel:
    node_ids: np.ndarray
    points: np.ndarray
    elements: list[Element]
    active: np.ndarray
    fixed: np.ndarray
    force: np.ndarray
    masses: list[tuple[int, float, np.ndarray]] = field(default_factory=list)
    springs: list[tuple[int, int, float, float, float]] = field(default_factory=list)
    links: list[tuple[int, int, np.ndarray]] = field(default_factory=list)
    contacts: list[dict[str, Any]] = field(default_factory=list)
    gravity: np.ndarray = field(default_factory=lambda: np.zeros(3))
    identity: str = ""
    provenance: dict[str, Any] = field(default_factory=dict)
    rotor: dict[str, Any] | None = None
    # 이력 출력이 요청한 절점의 합집합입니다. 해석 자유도는 줄이지 않습니다.
    # None은 순수 수치 API의 기본값으로 전체 절점을 보관합니다.
    history_nodes: np.ndarray | None = None
    # 집합에는 행 번호가 아닌 사용자가 지정한 절점 ID와 CAD 출처를 남긴다.
    # 해석 자유도/경계조건을 자동 변경하지 않는 이름 있는 메시 그룹이다.
    node_sets: dict[str, dict[str, Any]] = field(default_factory=dict)
    face_sets: dict[str, dict[str, Any]] = field(default_factory=dict)
    # CSG volume nodes precede internal connection/reference nodes.
    physical_node_count: int | None = None
    boundary_regions: dict[str, dict[str, Any]] = field(default_factory=dict)
    cell_regions: dict[str, np.ndarray] = field(default_factory=dict)
    result_requests: dict[str, Any] = field(default_factory=dict)

    @property
    def size(self) -> int:
        return len(self.points) * 6


@dataclass
class StructuralSolution:
    # 병진은 실제 변위입니다. 회전은 내부 적분 좌표이며, revolute link의
    # 자유 회전 slot에는 2*pi로 자르지 않은 master 상대각 q를 보관합니다.
    # 실제 자세는 orientations, 공간 속도/가속도는 velocity/acceleration입니다.
    # 공개 회전 출력은 이 내부 좌표 대신 log(orientations)를 사용합니다.
    displacement: np.ndarray
    velocity: np.ndarray
    acceleration: np.ndarray
    orientations: np.ndarray
    reaction: np.ndarray
    history: dict[str, Any]
    element_history: list[Any]
    stresses: list[Any]
    time: float = 0.0
    iterations: int = 0
    residual: float = 0.0
    strain_energy: float = 0.0
    kinetic_energy: float = 0.0
    spectrum: dict[str, Any] = field(default_factory=dict)
    contact_history: list[Any] = field(default_factory=list)
