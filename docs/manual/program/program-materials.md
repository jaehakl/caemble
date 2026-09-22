# 재료의 물성을 정하고 형상에 연결하기

Material은 실험에 사용할 물리 모델과 계수를 묶은 재료 정의입니다. 이 문서에서는 **재료를 만들고, 형상에 연결하고, Solver가 사용할 모델을 확인하는 순서**를 살펴봅니다. [파일 구성](program-overview.md)과 [단위·데이터 형식](../reference/reference-data-schema.md)을 함께 참고하면 좋습니다.

## 재료 이름과 물리 모델 구분하기

`new Material(name, { color?, models })`을 `material.tsx`에서 만들고, 이름이 있는 객체 또는 `vars`를 받아 재료를 만드는 함수로 내보냅니다. 이름은 Experiment와 모든 Task 안에서 재료를 구별하기 위한 것입니다. 이름만 입력한다고 외부에서 재료 물성을 찾아오지는 않습니다.

`models`의 키는 Material 안에서 각 모델을 구별할 이름입니다. 각 항목에는 정확한 버전의 `model` ID와 `parameters`를 입력합니다. 모델의 식, 파라미터 구조·단위·생략했을 때의 의미는 재료 모델 카탈로그에서 확인하고, 실제 계수는 소스에 직접 쓰거나 `vars`로 구성합니다. 별도의 계수 저장소, source/version 선택자, `errorRate` 표본 추출은 제공하지 않습니다.

[재료 모델 카탈로그](/doc?help=materials)에서 사용할 모델을 찾고 [Solver 카탈로그](/doc?help=solvers)에서 지원 조합을 확인하세요. 등록된 모델이라도 모든 Solver에서 사용할 수 있는 것은 아닙니다. 처음에는 공식 예제의 완성된 소스 묶음을 열어 연결 방식을 확인해 보세요.

## 파라미터를 채우고 형상에 연결하기

파라미터 구조는 값, 객체, 리스트로 구성됩니다. 선택 객체를 넣었다면 그 안의 필수 필드를 모두 채워야 하고 리스트의 각 항도 완전한 입력 세트여야 합니다. 수치 quantity에는 `value`, UCUM `unit`과 필요한 `dtype`·`basis`를 사용합니다. QuantityKind와 shape는 모델의 규격을 따르며 값에서 추정하거나 scalar를 tensor로 자동 확장하지 않습니다. 등방성 3×3 입력을 명시하려면 `Mat(value)`를 사용할 수 있습니다.

`materials`의 키는 `tire`, `wheel`, `shell`처럼 형상에서 사용할 역할 이름입니다. 기본 형상 요소는 `body` 역할의 재료를 사용합니다. 자식에서 재료 맵을 생략하면 부모의 맵을 물려받고, 명시하면 교체하며, `{}`를 지정하면 상속을 지웁니다. 중간 Geometry는 `materials={{ body: materials?.wheel }}`처럼 역할 이름을 연결할 수 있습니다. 같은 이름의 Material을 여러 부품에 사용할 수 있지만 Experiment와 Task 안에서 그 정의가 서로 달라서는 안 됩니다.

Solver의 모델 그룹은 각 대상 Material에 따로 적용됩니다. 필수 그룹마다 허용된 모델 인스턴스가 하나 필요하며, 여러 개가 호환되면 [Task의 명시적 모델 선택](/doc?help=manual&item=program-task)을 사용합니다. 다른 물리 영역의 유효한 모델은 함께 둘 수 있지만 미등록 모델이나 불완전한 파라미터는 실행을 차단합니다.

## 변수 변경과 저장 결과 확인하기

Vars를 바꾸어 새 Candidate를 만들면 `material.tsx`도 다시 평가합니다. Measurement에는 실제 사용한 모델 정의·계수·선택 결과와 source/vars 식별자를 저장합니다. 저장된 실행 입력은 당시의 스냅샷으로 재현하며 현재 소스나 외부 계수로 덮어쓰지 않습니다.

[서로 다른 두 재료를 연결한 Wheel Assembly 예제 열기](/doc?help=examples&item=caemble:experiment/caemble/assemblies/two-material-wheel-assembly@5.0.0)

## MaterialInteraction: 재료 쌍의 모델

두 재료 사이의 성질은 `material.tsx`에서 `new MaterialInteraction(name, { between: [first, second], models })`로 선언하고 named export합니다. `between`은 Material 객체 두 개를 받습니다. 같은 재료끼리의 접촉도 선언할 수 있습니다.

재료 쌍마다 객체 하나만 허용합니다. A–B와 B–A는 같은 쌍이므로 다른 이름으로도 중복 선언할 수 없습니다. 서로 다른 물리 모델은 그 객체의 `models` 안에 함께 선언합니다. 인스턴스 형식은 Material과 같은 `{ model, parameters }`이며 같은 모델 ID와 버전도 객체 안에서 한 번만 사용할 수 있습니다. Model Catalog의 대상이 재료 쌍인 모델만 넣을 수 있습니다. 대칭 모델은 양쪽 방향으로 사용하고, 순서가 있는 모델은 선언한 `between` 순서를 보존합니다.

Experiment에 별도의 Interaction 목록을 지정하지 않습니다. Candidate를 평가할 때 exported Interaction을 자동으로 찾고, Experiment와 Task Geometry에서 실제 사용한 두 Material에 해당하는 관계를 포함합니다. 사용하지 않은 선언도 중복·파라미터 검증을 받습니다. 같은 객체를 여러 이름으로 export한 경우는 한 선언으로 처리합니다.

Vars에 따라 계수를 바꾸려면 두 번째 인자로 `({ vars }) => ({ between, models })` 콜백을 사용합니다. 콜백은 Candidate마다 한 번 평가합니다. Vars의 타입은 `MaterialInteraction<{ friction: number }>`처럼 선언하면 콜백 안에서도 그대로 검사합니다. Material factory를 사용하는 경우 콜백에서도 같은 Vars로 같은 이름과 정의의 Material을 만들어야 합니다.

Task의 Solver가 같은 모델 그룹에서 여러 모델을 지원하고 Interaction에 그 후보들이 함께 있으면 `config.interactionModels[role][interactionName][group]`에 인스턴스 이름을 지정합니다. 후보가 하나이면 자동 선택합니다. 적용되지 않는 선택, 중복 모델 또는 필수 모델 누락은 오류입니다. 선택 그룹의 누락 동작은 Solver Catalog가 정의합니다.

Task 소스 아래의 Material Interactions에서 적용된 재료 쌍과 모델을 확인하고 `material.tsx`로 이동할 수 있습니다. Measurement는 관계의 계수와 Task별 선택도 함께 저장하며 실행 시 다시 검증합니다.

[정지 바닥 위 미끄럼 접촉 예제](/doc?help=examples&item=caemble:experiment/caemble/rigid/sliding-contact@1.0.0)

재료 연결을 마쳤다면 [Task 작성](program-task.md)에서 사용할 모델 선택을 확인하세요. 단위나 모델 오류가 나면 [단위·재료 문제 해결](../troubleshooting/troubleshooting-units-materials.md)의 순서로 점검할 수 있습니다.
