# target 또는 solver manifest 오류

## 증상과 확인 위치

Task 검증에서 method·target·호출 횟수 오류가 나오면 **Solver 카탈로그 → Methods**에서 같은 이름과 버전의 계약을 확인하세요. 재료 요구 사항은 **Materials**, 결과 연결은 **Artifacts**에서 확인합니다.

## 해결 순서

- Physics Catalog에서 `name@version`이 정확히 존재하는지 확인합니다.
- method가 `initializations`, `boundaryConditions`, `outputs` 중 어디에 속하는지 확인합니다.
- required parameter와 occurrence의 최소·최대 횟수를 확인합니다.
- target의 scene(`experiment`/`task`)과 kind(`geometry`/`surface`)를 확인합니다.
- group 이름이 source에 선언되어 있고 실제 Geometry 또는 surface로 resolve되는지 확인합니다.

검증 오류를 우회하기 위해 Solver 계약을 UI에 복사해 수정하지 마세요. [Solver 카탈로그](/?help=solvers)의 해당 버전 계약에 맞춰 Task를 수정하고 다시 빌드하세요. Launcher 실행 manifest는 이 Solver 계약과 별개입니다.
