# Geometry 저작 골격과 좌표계

CAD API v1 Geometry는 JSX를 반환하는 순수 함수 component입니다. `geometry.tsx`에는 재사용할 named `Geometry<Props>`를 두고, `experiment.tsx`의 `geometry` callback에서 호출합니다. 모든 custom prop은 required/optional 표기와 관계없이 구조 분해 initializer가 있어야 하므로 `<Assembly />`처럼 props 없이 호출할 수 있습니다. 숫자로 된 길이는 모두 해당 scene의 `lengthUnit`으로 해석됩니다.

새 Experiment를 만들 때 Workbench가 제공하는 starter source bundle도 이 규칙을 따르며, AI reference 생성 시 같은 `experiment.tsx`와 `geometry.tsx`를 사용합니다.

좌표계는 오른손 좌표계입니다. `+X`, `+Y`, `+Z`와 회전의 양의 방향에는 오른손 법칙을 적용합니다. primitive의 기준축과 원점은 요소마다 다르므로 추측하지 말고 [Geometry Catalog](/docs?section=geometry)의 **Origin / surfaces**를 확인하세요. 예를 들어 기본 cylinder 축은 Z이고, box와 cylinder는 자신의 local origin을 중심으로 생성됩니다.

component는 입력 props와 `vars`만으로 같은 tree를 만들어야 합니다. 시간, 난수, DOM, 네트워크나 변경 가능한 module 상태에 의존하면 같은 source와 Measurement를 재현할 수 없습니다.

Primitive는 props를 생략하면 Catalog에 표시된 canonical 단위 형상 기본값을 사용합니다. 자동 ID는 authoring name의 lower-kebab과 sibling 순번(`box`, `box-2`)으로 정해집니다.

`for`, `Array.from`/`map`, `if`와 조건부 JSX를 사용할 수 있습니다. 반복 횟수는 유한하고 입력으로 재현 가능해야 하며, 반복되는 sibling에는 삽입·재정렬에도 유지되는 index나 domain key 기반의 명시적 `id`를 만드세요. 규칙적인 격자는 JS loop보다 `array` operation을 우선합니다.
