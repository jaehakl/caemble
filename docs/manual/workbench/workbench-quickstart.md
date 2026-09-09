# CAE Workbench 빠른 시작

Caemble의 Experiment는 공통 형상과 변수, Material, solver Task, 실행 프로그램과 RecordedData 계약을 하나의 source bundle로 관리합니다.

## 먼저 준비할 것

형상과 문서는 로그인 없이 살펴볼 수 있습니다. 서버에 Measurement를 저장하고 Solver를 실행하려면 로그인과 사용 가능한 내 CAE Launcher가 필요합니다. 실행 전에 **Setting → Launchers**에서 연결 상태를 확인하세요.

## 첫 실행의 목표

| 단계      | 할 일                                           | 확인할 결과                                                  |
| --------- | ----------------------------------------------- | ------------------------------------------------------------ |
| 작성      | Experiment에서 예제를 열고 Source를 확인합니다. | source 상태가 `Ready`이고 Viewer에 형상이 보입니다.          |
| 조건 확인 | Vars와 Material Parameter를 확인합니다.         | 원하는 Candidate의 형상과 값이 일치합니다.                   |
| 저장·실행 | Measurement를 준비하고 실행합니다.              | CAE Jobs에 작업이 등록되고 Console에 진행 상태가 표시됩니다. |
| 결과 확인 | 완료된 Measurement를 선택합니다.                | RecordedData가 표시되고 Calculation에서 계산할 수 있습니다.  |

## 순서대로 진행하기

1. 로그인하고 CAE Launcher가 연결되어 있는지 확인합니다.
2. 상단 **Experiment** 메뉴를 선택하고 왼쪽 목록에서 Example 또는 저장된 namespace / repository / SemVer Version을 연 뒤, 오른쪽 Source 탭에서 source bundle을 작성합니다.
3. source 상태가 `Ready`가 될 때까지 compile/evaluate 오류를 해결합니다.
4. **Generate Candidate**로 `varsSchema` 범위의 새 변수 조건과 그 조건에서 만든 Model Parameter를 미리 봅니다.
5. 원하는 조건이면 **Save Current Measurement**로 변수와 Material snapshot을 고정합니다. 이 단계는 solver를 실행하지 않습니다.
6. 상단 **Calculation** 메뉴의 왼쪽 점 배열에서 prepared Measurement를 선택합니다. Ctrl/Cmd+클릭으로 여러 항목을 선택하고 Shift+클릭으로 현재 페이지의 범위를 선택할 수 있습니다.
7. **Generate & Run**은 브라우저에서 새 Candidate와 실행 입력을 build한 뒤 서버에 batch로 제출합니다. **Save & Run**은 화면에서 확인한 Vars와 Material snapshot을 그대로 고정하여 build합니다.
8. 횟수를 입력하고 **Sample & Run**을 누르면 Vars 범위에서 Monte Carlo(random) 방식으로 후보를 뽑고, 브라우저에서 모든 실행 입력을 먼저 build한 뒤 한 번의 batch로 제출합니다. Prediction의 Sample & Run은 기존 LHS 후보 선택 방식을 사용합니다. 기본값은 10이며, N은 성공 횟수가 아니라 전체 시도 횟수입니다. 서버가 사용 가능한 내 Launcher에 작업을 하나씩 배분합니다.
9. build와 업로드가 끝나 서버 접수가 완료되면 브라우저를 닫아도 CAE 계산은 계속됩니다. 로컬 build나 업로드 중에는 브라우저를 유지하세요. 작업별 진행률과 완료·실패 알림은 **Console**에 표시됩니다. **Setting → CAE Jobs**에서 배치 목록과 오류를 확인하고 실패한 작업을 명시적으로 재시도할 수 있으며, **Batch 취소**는 아직 끝나지 않은 작업을 취소합니다.
10. 기존 Prepared Measurement는 **Run**으로 실행합니다. 실행이 실패한 작업은 **CAE 작업**에서 재시도하세요. 서버나 worker 연결 중단을 포함한 실패는 자동으로 다시 실행하지 않습니다.
11. CAE worker가 큰 결과 본문을 S3에 직접 업로드하고 서버에 RecordedData 참조가 원자적으로 저장되면 Measurement는 Recorded 상태가 됩니다. 선택 중인 Measurement의 결과는 서버 완료 이벤트를 받은 뒤 즉시 다시 불러옵니다.

큰 BuiltMeasurement와 결과 본문은 Client ↔ S3 ↔ Slave 경로로 전달됩니다. 브라우저는 결과를 S3에서 직접 읽고, 서버는 권한·참조·작업 상태를 관리합니다.

## 실행 전후에 기억할 점

Measurement는 immutable Experiment revision을 가리킵니다. 생성 요청의 source hash가 현재 revision과 다르면 저장이 거부되므로, source가 바뀌면 새 revision에서 새 Measurement를 준비하세요.

Task 파일이 하나도 없는 Experiment도 Geometry preview와 Experiment 저장은 사용할 수 있습니다. 이 경우 Measurement 생성·선택·분석과 Simulation 실행은 Task를 추가할 때까지 비활성화됩니다.

## 다음 단계

- source가 준비되지 않으면 [Ready 문제 해결](../troubleshooting/troubleshooting-ready.md)을 확인하세요.
- 실행 후에는 [Calculation으로 결과 계산](workbench-calculation.md)을 이어서 진행하세요.
- 정확한 문법이나 완성 예제는 Help의 **Geometry**, **Solver**, **Examples**에서 찾을 수 있습니다.
