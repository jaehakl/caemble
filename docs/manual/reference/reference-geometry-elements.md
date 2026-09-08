# Primitive 선택과 operation 규칙

표현할 수 있다면 `Box`, `Cylinder`, `Sphere`부터 사용하세요. Primitive는 `@caemble/core`에서 PascalCase로 import하고 operation은 lowercase JSX tag로 작성합니다. 곡선 단면·표면이 실제 요구사항일 때만 `CurvedEdgeCylinder`, `CurvedSurfaceSphere`, `Fiber`를 선택하면 parameter와 mesh 비용을 줄일 수 있습니다. 각 prop의 type, 필수 여부, 기본값, 제약, 기준 원점, surface 의미와 실행 가능한 예제는 [Geometry Catalog](/docs?section=geometry)가 공식 원본입니다.

| Operation | child 계약 | 핵심 규칙 |
| --- | --- | --- |
| `translate` | 1개 이상 | `offset` Vec3로 child group을 상대 이동 |
| `rotate` | 1개 이상 | `axis`와 radian `angle`로 오른손 axis-angle 회전 |
| `scale` | 1개 이상 | `x`, `y`, `z` 축별 배율을 local 원점 기준으로 적용 |
| `union` | 1개 이상 | 모든 child를 하나의 결과로 결합 |
| `subtract` | 2개 이상 | 첫 child가 base, 이후 child는 cutter |
| `intersect` | 2개 이상 | 모든 child의 공통 체적만 유지 |
| `shell` | 정확히 1개 | material role별 offset surface 생성 |
| `array` | 정확히 1개의 identified intrinsic 또는 `Geometry` child | `shape`, `period`, 선택적 `axes`와 canonical `inject`로 instance 생성 |

Boolean child 순서는 source 계약의 일부입니다. ring은 큰 cylinder 하나로 근사하지 말고, 큰 cylinder에서 더 높고 작은 cylinder를 빼서 실제 annular solid를 만드세요. 0 두께, 음수 크기, NaN/Infinity, 퇴화한 축처럼 유효하지 않은 입력은 evaluator가 거부합니다.

Material은 root에서 역할 map으로 주입하고 leaf에서 `body`로 remap합니다. 생략하면 parent map을 상속하고, 명시하면 교체하며, `materials={{}}`는 상속을 지웁니다. 자세한 모델 입력과 역할 계약은 [Material과 Model Parameter](/docs?section=program#experiment-materials)을 참고하세요.
