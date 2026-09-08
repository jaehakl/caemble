# Material 역할과 Model Parameter

Material은 이번 Experiment에서 사용할 모델 인스턴스와 명시적인 계수의 묶음입니다. `new Material(name, { color?, models })`을 `material.tsx`에서 만들고 named 객체 또는 `vars`를 받는 factory로 export합니다. 이름은 Experiment와 모든 Task 안에서 구별하기 위한 것이며 외부 재료 데이터 조회에 사용하지 않습니다.

`models`의 key는 Material 내부의 인스턴스 이름입니다. 각 인스턴스에는 정확한 버전의 `model` ID와 `parameters`를 입력합니다. Model Catalog가 모델 식, 파라미터 구조·단위·생략 의미를 소유하고, 실제 계수는 소스에 직접 쓰거나 `vars`로 구성합니다. 별도의 계수 저장소, source/version 선택자와 `errorRate` sampling은 없습니다.

[Model Catalog](/?help=materials)에서 사용할 모델을 확인하고 [Physics Catalog](/?help=solvers)에서 해당 Solver의 지원 조합을 확인하세요. 모델이 등록되어 있어도 모든 Solver가 지원하는 것은 아닙니다. 실행 가능한 완성 예제는 Catalog의 Experiment bundle을 사용합니다.

파라미터 구조는 값, 객체, 리스트로 구성됩니다. 선택 객체를 넣었다면 그 안의 필수 필드를 모두 채워야 하고 리스트의 각 항도 완전한 입력 세트여야 합니다. 수치 quantity에는 `value`, UCUM `unit`과 필요한 `dtype`·`basis`를 사용합니다. QuantityKind와 shape는 모델의 규격을 따르며 값에서 추정하거나 scalar를 tensor로 자동 확장하지 않습니다. 등방성 3×3 입력을 명시하려면 `Mat(value)`를 사용할 수 있습니다.

`materials` key는 `tire`, `wheel`, `shell` 같은 Geometry 역할 이름입니다. primitive는 `body` 역할을 소비합니다. child에서 map을 생략하면 상속하고, 명시하면 교체하며, `{}`는 상속을 지웁니다. 중간 Geometry는 `materials={{ body: materials?.wheel }}`처럼 역할을 remap할 수 있습니다. 같은 이름의 Material을 여러 부품에 사용할 수 있지만 Experiment와 Task 안에서 그 정의가 서로 달라서는 안 됩니다.

Solver의 모델 그룹은 각 대상 Material에 따로 적용됩니다. 필수 그룹마다 허용된 모델 인스턴스가 하나 필요하며, 여러 개가 호환되면 [Task의 명시적 모델 선택](/?help=manual&item=program-task)을 사용합니다. 다른 물리 영역의 유효한 모델은 함께 둘 수 있지만 미등록 모델이나 불완전한 파라미터는 실행을 차단합니다.

Vars를 바꾸어 새 Candidate를 만들면 `material.tsx`도 다시 평가합니다. Measurement에는 실제 사용한 모델 정의·계수·선택 결과와 source/vars 식별자를 저장합니다. 저장된 실행 입력은 그 snapshot으로 재현하며 현재 소스나 외부 계수로 덮어쓰지 않습니다.

[Two-material Wheel Assembly의 canonical Experiment bundle 열기](/?help=examples&item=caemble:experiment/caemble/assemblies/two-material-wheel-assembly@3.0.0)
