# target 또는 solver manifest 오류

- Physics Catalog에서 `name@version`이 정확히 존재하는지 확인합니다.
- method가 `initializations`, `boundaryConditions`, `outputs` 중 어디에 속하는지 확인합니다.
- required parameter와 occurrence의 최소·최대 횟수를 확인합니다.
- target의 scene(`experiment`/`task`)과 kind(`geometry`/`surface`)를 확인합니다.
- group 이름이 source에 선언되어 있고 실제 Geometry 또는 surface로 resolve되는지 확인합니다.

solver manifest 내용을 UI에 복사해 고치지 마세요. 배포된 manifest와 [Physics Catalog](/docs?section=solvers)가 현재 계약입니다.
