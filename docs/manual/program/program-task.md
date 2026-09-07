# tasks/*.tsx: solver task 선언

`defineTask({...})`는 `kernel: { name, version }`, Task 전용 `lengthUnit`과 `geometry`, 그리고 `config({ vars })`를 선언합니다. Geometry를 사용하지 않아도 현재 계약에 맞는 scene과 단위를 명시하세요.

Catalog에는 Solver 이름마다 현재 버전 하나와 그 버전에 맞는 예제를 제공합니다. 제거된 Solver 버전을 참조하는 Experiment는 오류가 나며 자동으로 새 버전을 선택하지 않습니다. 기존 source를 고치려면 현재 예제와 계약을 기준으로 새 Experiment Version을 만드세요.

`parameters`, `initializations`, `boundaryConditions`, `outputs`의 이름과 occurrence는 [Physics Catalog](/docs?section=solvers)의 현재 manifest가 단일 원본입니다. target은 `experiment.geometry.*`, `experiment.surface.*`, `task.geometry.*`, `task.surface.*` 중 method가 요구하는 source/kind와 일치해야 합니다.

[Electro-Thermal Notched Bar의 canonical Task source 열기](/docs?section=solvers&item=experiment:caemble:experiment/caemble/verified/electro-thermal-notched-bar@2.0.0)
