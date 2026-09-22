# Geometry 작성의 기본 구조와 좌표계

Geometry는 코드로 작성하는 형상입니다. 기본 요소를 배치하고 조합하는 함수를 만들어 여러 Task에서 재사용할 수 있습니다. 처음 작성한다면 [공식 예제](/doc?help=examples)의 `geometry.tsx`를 열고, 아래 순서로 읽어 보세요.

## 재사용할 형상 함수 만들기

CAD API v1의 Geometry는 JSX를 반환하는 순수 함수 컴포넌트입니다. `geometry.tsx`에는 이름이 있는 `Geometry<Props>`를 두고, `experiment.tsx`의 `geometry` 콜백에서 호출합니다. 모든 사용자 정의 속성은 필수·선택 표기와 관계없이 구조 분해 시 기본값을 지정해야 합니다. 그래야 `<Assembly />`처럼 사용자 정의 속성을 생략해도 기본 형상을 확인할 수 있습니다. 컴포넌트를 실제로 호출할 때의 `id` 규칙은 [형상 ID 안내](reference-geometry-identity.md)를 참고하세요.

숫자로 된 길이는 모두 해당 장면(scene)의 `lengthUnit`으로 해석합니다. 형상의 숫자를 바꾸기 전에 먼저 이 단위를 확인하세요.

새 Experiment를 만들 때 Workbench가 제공하는 starter source bundle도 이 규칙을 따르며, AI reference 생성 시 같은 `experiment.tsx`와 `geometry.tsx`를 사용합니다.

## 원점과 길이 단위 확인하기

좌표계는 오른손 좌표계입니다. `+X`, `+Y`, `+Z`와 회전의 양의 방향에는 오른손 법칙을 적용합니다. 기본 형상 요소의 기준축과 원점은 요소마다 다르므로 [형상 카탈로그](/doc?help=geometry)의 **Origin / surfaces**를 확인하세요. 예를 들어 기본 Cylinder의 축은 Z이고, Box와 Cylinder는 자신의 로컬 원점을 중심으로 생성됩니다.

형상 함수는 입력 속성과 `vars`가 같으면 같은 형상 트리를 만들어야 합니다. 시간, 난수, DOM, 네트워크나 변경 가능한 모듈 상태에 의존하면 같은 소스와 Measurement를 재현할 수 없습니다.

기본 형상 요소의 속성을 생략하면 카탈로그에 표시된 기본값을 사용합니다. 자동 ID는 작성 이름을 소문자·하이픈 형태로 바꾸고 같은 부모 아래의 순번을 붙여 정합니다. 예를 들면 `box`, `box-2`입니다.

## 반복되는 부품 배치하기

`for`, `Array.from`/`map`, `if`와 조건부 JSX를 사용할 수 있습니다. 반복 횟수는 유한하고 입력으로 재현 가능해야 합니다. 같은 부모 아래에 반복되는 부품에는 삽입·재정렬 후에도 의미가 유지되는 인덱스나 대상의 고유 키를 이용해 명시적인 `id`를 지정하세요. 규칙적인 격자를 만들 때는 JavaScript 반복문보다 `array` 연산을 먼저 검토해 보세요.

작성 후에는 Viewer에서 크기와 기준 위치를 확인합니다. 위치·회전을 바꾸려면 [형상 변환](reference-geometry-transforms.md), 부품을 결합하거나 깎으려면 [기본 형상과 연산](reference-geometry-elements.md)으로 이어가세요.
