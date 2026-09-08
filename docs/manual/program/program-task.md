# tasks/*.tsx: solver task 선언

`defineTask({...})`는 `kernel: { name, version }`, Task 전용 `lengthUnit`과 `geometry`, 그리고 `config({ vars })`를 선언합니다. Geometry를 사용하지 않아도 현재 계약에 맞는 scene과 단위를 명시하세요.

Catalog에는 Solver 이름마다 현재 버전 하나와 그 버전에 맞는 예제를 제공합니다. 제거된 Solver 버전을 참조하는 Experiment는 오류가 나며 자동으로 새 버전을 선택하지 않습니다. 기존 source를 고치려면 현재 예제와 계약을 기준으로 새 Experiment Version을 만드세요.

`parameters`, `initializations`, `boundaryConditions`, `outputs`의 이름과 occurrence는 [Physics Catalog](/?help=solvers)의 현재 manifest가 단일 원본입니다. target은 `experiment.geometry.*`, `experiment.surface.*`, `task.geometry.*`, `task.surface.*` 중 method가 요구하는 source/kind와 일치해야 합니다.

[Electro-Thermal Notched Bar의 canonical Task source 열기](/?help=examples&item=caemble:experiment/caemble/verified/electro-thermal-notched-bar@3.0.0)

Material 역할마다 `modelGroups`에 선언된 그룹을 모두 확인합니다. 각 필수 그룹 안에서는 `oneOf`에 포함된 모델 인스턴스 하나를 선택합니다. 호환 인스턴스가 여러 개이면 `config({ vars })`의 `materialModels[role][materialName][groupKey]`에 선택한 인스턴스 이름을 지정하세요. 그룹·Material·인스턴스 이름이 틀리거나 선택한 모델이 호환되지 않으면 오류가 납니다.

RC/TRC 같은 수치 방법은 Task 설정입니다. Material의 물리 모델과 별개로 선택하며, 선택한 모델을 지원하지 않는 방법으로 조용히 대체하지 않습니다.
