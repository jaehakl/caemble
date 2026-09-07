# Material 역할과 물성값

`new Material(...)`은 `material.tsx`에서만 사용합니다. named Material 객체 또는 factory를 export하고 Experiment와 Task는 이를 import해 root Geometry의 역할 map에 주입합니다.

`materials` key는 `tire`, `wheel`, `shell` 같은 역할 이름입니다. primitive는 `body` 역할을 소비합니다. child에서 `materials`를 생략하면 map을 상속하고, 명시하면 교체하며, `{}`는 상속을 지웁니다. 중간 Geometry는 `materials={{ body: materials?.wheel }}`처럼 역할을 remap할 수 있습니다.

Property는 [Material Catalog](/docs?section=materials)의 canonical key를 사용하고 solver가 요구하는 `dtype`, UCUM `unit`, QuantityKind와 tensor shape를 맞춥니다. 등방성 2차 tensor는 `Mat(value)`로 표현할 수 있습니다.

`errorRate`가 있으면 Candidate의 frozen 값이 달라질 수 있습니다. 같은 이름과 선언의 Material은 Experiment와 모든 Task에서 한 번만 sampling되며, 저장한 Measurement에는 실제 parameter snapshot이 고정됩니다. unresolved 역할은 preview할 수 있지만 Measurement 생성과 solver 실행은 차단됩니다.

[Two-material Wheel Assembly의 canonical Experiment bundle 열기](/docs?section=solvers&item=experiment:caemble:experiment/caemble/assemblies/two-material-wheel-assembly@2.0.0)
