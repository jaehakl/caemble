# @caemble/core 핵심 API

`@caemble/core`는 Experiment의 형상, 재료와 해석 작업을 작성할 때 사용하는 공개 API입니다. 이 문서는 **무엇을 어디에서 쓰는지 빠르게 찾는 용도**로 활용하세요. 소스 파일을 처음 읽는다면 [Experiment 파일 구성](../program/program-overview.md)부터 시작하면 좋습니다.

## 자주 사용하는 API

| API               | 사용 위치          | 역할                                                                      |
| ----------------- | ------------------ | ------------------------------------------------------------------------- |
| `experiment`      | `experiment.tsx`   | 공통 형상·변수, 재료 역할 연결, 대상 그룹과 저장할 결과 선언 |
| `defineTask`      | `tasks/*.tsx`      | Solver와 버전, Task 전용 형상과 계산 설정 선언 |
| `Material`        | `material.tsx`     | 실험에서 사용할 물리 모델과 계수를 재료로 묶기 |
| `Mat`             | 재료의 텐서 값 | 숫자 하나를 등방성 3×3 텐서로 표현 |
| `Geometry<Props>` | TSX 컴포넌트 타입 | 재사용할 형상 컴포넌트의 속성 정의 |
| `Vec3`            | 위치·크기 속성 | 숫자 3개로 이루어진 벡터 타입 |
| `Box` 등          | 형상 TSX | PascalCase 이름으로 가져오는 기본 형상 요소 |
| `radians`         | 형상 변환 | 도 단위 숫자 또는 Vec3를 라디안으로 변환 |

## 정확한 문법과 예제 찾기

형상 요소의 실제 태그와 속성 문법은 [형상 카탈로그](/doc?help=geometry), Solver 메서드와 파라미터는 [Solver 카탈로그](/doc?help=solvers)에서 확인하세요. 이 표는 역할을 설명하기 위한 요약이며, 전체 입력 규격을 대신하지 않습니다.

- 형상을 만들려면 [Geometry 기본 구조](reference-geometry-skeleton.md)를 읽어 보세요.
- 값의 모양과 단위를 정하려면 [DataSchema 안내](reference-data-schema.md)를 참고하세요.
- 파일을 나누어 작성하려면 [소스와 import 규칙](reference-source-import.md)을 확인하세요.
