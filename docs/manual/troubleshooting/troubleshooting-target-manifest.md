# Solver 작업과 대상 지정 오류 해결하기

Solver 작업은 정해진 형식의 입력과 계산 대상을 요구합니다. 오류 메시지의 method와 target은 각각 계산에 사용할 기능과 그 기능을 적용할 형상·면을 가리킵니다.

## 증상과 확인 위치

Task 검증에서 method·target·호출 횟수 오류가 나오면 **Solver 카탈로그 → Methods**에서 소스와 같은 이름·버전의 규격을 확인하세요. 필요한 재료는 **Materials**, 결과 연결은 **Artifacts**에서 확인합니다.

## 해결 순서

1. [Solver 카탈로그](/doc?help=solvers)에 소스의 `name@version`이 정확히 있는지 확인합니다.
2. method가 초기화(`initializations`), 경계 조건(`boundaryConditions`), 출력(`outputs`) 중 어디에 속하는지 확인합니다.
3. 필수 파라미터와 설정할 수 있는 최소·최대 횟수(occurrence)를 비교합니다.
4. 대상이 Experiment와 Task 중 어느 장면에 있는지(`experiment`/`task`), 형상 전체와 면 중 무엇인지(`geometry`/`surface`) 확인합니다.
5. 그룹 이름이 소스에 선언되어 있고, 그 구성원이 실제 형상이나 면을 가리키는지 확인합니다. 실제 경로는 [Viewer의 대상 선택](../workbench/workbench-viewer-selection.md)으로 확인할 수 있습니다.

## 해결 확인

해당 Solver 버전의 규격에 맞춰 Task를 수정한 뒤 다시 빌드하세요. 검증을 통과하면 의도한 형상과 면이 대상으로 선택되는지 확인합니다. 재료나 단위 오류가 남으면 [Material 오류 해결](troubleshooting-units-materials.md)을 이어서 살펴보세요.

Solver 규격의 원본은 카탈로그입니다. 오류를 우회하려고 규격을 UI에 복사해 고치지 마세요. Launcher 실행에 사용하는 manifest 파일은 여기서 다루는 Solver 입력 규격과 별개입니다.
