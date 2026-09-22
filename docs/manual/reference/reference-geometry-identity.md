# 형상 ID와 그룹으로 해석 대상 지정하기

해석 조건을 적용하려면 먼저 **어느 부품인지, 어느 표면인지** 구별할 수 있어야 합니다. `id`는 형상을 식별하고, `geometryGroup`과 `surfaceGroup`은 해석에 사용할 대상을 이름으로 묶습니다. [Geometry 기본 구조](reference-geometry-skeleton.md)와 [Viewer 선택 안내](../workbench/workbench-viewer-selection.md)를 함께 보면 이해하기 쉽습니다.

## ID는 어디에 붙이나요

`id`는 화면에 보이는 이름만이 아니라 형상 결과의 식별자입니다. 사용자 정의 `Geometry` 컴포넌트 호출에는 `id`가 필수이고, 기본 형상 요소와 연산에도 필요할 때 지정할 수 있습니다. Fragment(`<>...</>`)에는 `id`나 변환을 지정할 수 없습니다.

- 기본 형상 요소의 `id`는 그 요소가 만든 부품을 식별합니다.
- `union`, `subtract`, `intersect`처럼 형상의 연결 구조를 바꾸는 연산에 `id`가 있으면 그 연산의 최종 결과에 붙습니다. 입력 부품의 ID와 Boolean 결과의 ID를 같다고 가정하지 마세요.
- 컴포넌트의 `id`는 그 안에 있는 형상들의 경로 시작점이 됩니다. 같은 부모 아래의 ID는 서로 달라야 합니다.
- 평가기가 컴포넌트 호출의 `id`를 이미 처리하므로, 받은 `id`를 가장 안쪽 형상 요소에 그대로 전달하지 마세요. 자식에 별도 경로가 필요할 때 그 자식의 `id`를 지정합니다.

## 그룹과 표면을 확인하는 순서

1. `geometryGroup`에는 의도적으로 지정한 결과 ID를 넣습니다.
2. 표면을 지정할 때는 `<geometry-id>/surface/<non-negative-index>` 형식을 사용합니다. 예를 들어 `conductor.body` Box의 로컬 +X 표면은 `conductor.body/surface/1`입니다. 해당 요소에 명시적 `id`를 주고 [형상 카탈로그](/doc?help=geometry)의 고정 표면 번호를 확인하세요.
3. 실행 전에 Viewer에서 실제 선택되는 부품과 면을 확인합니다. 변수나 Boolean 연산을 바꾼 뒤에도 의도한 대상이 선택되는지 다시 살펴보세요.

## 식별자와 형상의 제한

- 공식 카탈로그는 각 예제의 공개 계약 v1 버전만 제공합니다. 제거된 이전 주소에는 별칭이나 자동 이동이 없으며 조회 시 `404 catalog_not_found`를 반환합니다.
- Boolean 연산 하나에는 최대 128개의 피연산자를 넣을 수 있습니다. 큰 격자를 중첩 Boolean으로 펼치면 삼각형 수와 삼각형 쌍의 계산량 한도를 넘어 Manifold 실행 전에 거부될 수 있습니다.

중간 조립체에 이름이 필요하면 Fragment 대신 이름이 있는 `Geometry` 컴포넌트로 나누어 보세요. Solver가 최종 Boolean 형상 하나를 대상으로 사용한다면 연산에 `id`를 지정하면 그 대상을 분명하게 표현할 수 있습니다.

그룹을 만들었다면 [Task 작성](../program/program-task.md)에서 조건을 연결하세요. 대상을 찾지 못한다면 [대상·Solver 설정 문제 해결](../troubleshooting/troubleshooting-target-manifest.md)을 참고하세요.
