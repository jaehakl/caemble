# @caemble/core 핵심 API

| Symbol | 사용 위치 | 역할 |
| --- | --- | --- |
| `experiment` | `experiment.tsx` | 공통 geometry, vars, Material 역할 주입, group과 RecordedData schema 정의 |
| `defineTask` | `tasks/*.tsx` | solver identity, Task scene과 config 정의 |
| `Material` | `material.tsx` | canonical property와 sampling/freeze 정책 정의 |
| `Mat` | Material tensor 값 | scalar를 등방성 3×3 tensor로 표현 |
| `Geometry<Props>` | TSX component type | 재사용 가능한 Geometry component의 props 정의 |
| `Vec3` | 위치·크기 props | 길이 3 vector type |
| `Box` 등 | Geometry TSX | PascalCase primitive literal alias |
| `radians` | Geometry transform | degree number 또는 Vec3를 radian으로 변환 |

Geometry element의 실제 tag와 prop syntax는 [Geometry Catalog](/docs?section=geometry), solver method와 parameter는 [Physics Catalog](/docs?section=solvers)를 사용하세요. catalog가 declaration과 manifest의 최신 단일 원본입니다.
