# CAE Workbench 빠른 시작

처음이라면 완성된 예제를 열어 형상을 살펴보고, 조건 하나를 바꿔 계산해 보세요. 이 문서는 예제를 준비하는 순간부터 첫 결과를 확인할 때까지 안내합니다. 소스를 처음부터 작성할 필요는 없습니다.

## 첫 실행의 목표

Caemble에서 **Experiment**는 형상, 변수, 재료와 계산 방법을 모아 놓은 실험 설계입니다. **Measurement**는 그 설계에 특정 조건을 적용한 실행 기록입니다. 계산 전에는 조건을 담고, 계산이 끝나면 결과도 함께 연결됩니다.

| 단계 | 할 일 | 확인할 결과 |
| --- | --- | --- |
| 예제 열기 | Experiment에서 예제를 적용합니다. | Viewer에 형상이 보이고 소스 상태가 `Ready`가 됩니다. |
| 조건 확인 | Measurement에서 Vars를 살펴봅니다. | 변수값과 그 값으로 만든 형상이 일치합니다. |
| 한 번 실행 | 저장한 Experiment에서 **선택 Run**을 누릅니다. | Console과 CAE Jobs에서 진행 상태를 확인할 수 있습니다. |
| 결과 보기 | 계산을 마친 Measurement를 확인합니다. | 실제 결과 Viewer에 기록된 데이터가 나타납니다. |

## 먼저 준비할 것

형상과 문서는 로그인 없이 볼 수 있습니다. 먼저 구경하고 싶다면 [Showcase에서 예제 둘러보기](workbench-showcase.md)로 시작하세요.

직접 실행하려면 로그인한 계정과 연결된 **CAE Launcher**가 필요합니다. Launcher는 Solver를 실행할 컴퓨터를 Caemble에 연결합니다. **Setting → Launchers**에서 사용 가능한 내 Launcher가 연결되어 있는지 확인하세요.

> 공개 Demo는 다른 사람이 미리 준비한 결과를 체험하는 공간입니다. 내 조건으로 저장하고 실행하려면 편집 가능한 내 Experiment를 사용하세요.

## Workbench 진입

`/workbench`를 엽니다. 복원할 로컬 작업이나 URL로 지정한 Experiment가 없으면 **Experiment** 화면에서 시작합니다. 저장된 Experiment가 있으면 첫 namespace의 첫 항목을, 없으면 첫 예제를 엽니다. 다시 방문하면 이전 로컬 작업과 저장된 선택을 복원합니다.

화면 위의 탭은 작업 순서에 따라 **Experiment → Measurement → Calculation → Prediction → Analysis**로 나뉩니다.

| 탭 | 여기서 하는 일 |
| --- | --- |
| Experiment | 형상과 소스를 살펴보고 실험 설계를 저장합니다. |
| Measurement | 변수 조건을 만들고 Solver를 실행해 결과를 기록합니다. |
| Calculation | 기록된 결과에서 평균, 그래프 등 필요한 값을 계산합니다. |
| Prediction | 기존 결과를 바탕으로 새 조건의 결과나 목표에 맞는 조건을 예측합니다. |
| Analysis | 저장된 후처리 결과를 비교하고 변수와 결과의 관계를 살펴봅니다. |

## 순서대로 진행하기

### 1. 예제를 열고 형상 확인하기

**Experiment → New**를 눌러 **Templates**를 엽니다. 예제를 선택해 내용을 확인한 뒤 **적용**을 누르면 소스와 함께 제공되는 Calculation 정의를 가져옵니다. 저장된 내 작업을 이어서 하려면 [Showcase](workbench-showcase.md)에서 해당 버전을 골라 Workbench로 여세요.

왼쪽 Viewer에서 형상을, 오른쪽 편집기에서 소스를 볼 수 있습니다. 소스가 `Ready`가 되면 다음 단계로 진행합니다. 오류가 보인다면 [Ready 문제 해결](../troubleshooting/troubleshooting-ready.md)에서 첫 오류부터 확인하세요.

### 2. 내 Experiment로 저장하기

**Save** 또는 **Save As**에서 이름과 저장 위치를 확인하고 저장합니다. 공개 Demo나 읽기 전용 항목을 열었다면 **Save As**로 내 작업을 만드세요. Measurement를 만들거나 실행하려면 저장된 소스와 현재 작업이 일치해야 합니다.

처음에는 새 Experiment로 저장하면 됩니다. 기존 버전을 이어서 관리하는 방법은 [Experiment 저장과 버전 관리](workbench-save.md)를 참고하세요.

### 3. 변수 조건 하나 준비하기

**Measurement** 탭으로 이동합니다. **Vars**는 형상이나 재료를 바꾸는 변수값입니다. 항목을 선택해 값을 확인하거나 허용 범위 안에서 바꾸고, Enter를 누르거나 입력칸 밖으로 이동해 확정하세요.

다른 조건을 하나 만들어 보려면 생성 방식을 **Random**, 개수 **N을 1**로 설정하고 **후보 생성**을 누릅니다. 선택한 후보의 값과 형상을 확인하세요. 이 단계는 조건을 준비할 뿐 Solver를 실행하지 않습니다.

### 4. 선택한 조건 실행하기

**선택 Run**을 누르면 선택한 후보의 조건을 그대로 준비해 실행합니다. 먼저 저장만 하고 나중에 실행하려면 **Prepared 저장**을 사용하세요. Prepared는 조건이 저장되었지만 결과는 아직 없는 상태입니다.

입력 준비와 업로드가 끝나 서버에 접수될 때까지 브라우저를 유지하세요. 접수된 계산은 브라우저를 닫아도 서버에서 계속됩니다. 여러 후보를 순서대로 준비하는 중이라면 아직 제출하지 않은 후보를 위해 브라우저를 열어 두어야 합니다.

실행 버튼을 누를 수 없다면 로그인, Experiment 저장 상태, Vars의 미확정 입력, 소스 오류를 차례로 확인하세요. 자세한 점검은 [Measurement 실행 또는 결과 오류](../troubleshooting/troubleshooting-runtime-results.md)에 있습니다.

### 5. 결과 확인하기

**Console**에서 진행 상황을 확인합니다. **Setting → CAE Jobs**에서는 배치와 개별 작업의 상태·오류를 확인할 수 있습니다. 첫 화면에는 최근 배치 **50개**와 진행 중이거나 완료 알림을 아직 확인하지 않은 배치가 표시되며, 이전 이력은 **더 보기**로 불러옵니다. 재연결하면 마지막으로 받은 이벤트부터 변경 사항을 이어받습니다.

결과 저장이 끝나면 Measurement가 **Recorded** 상태가 되고 실제 결과 Viewer에 데이터가 나타납니다. 예측이 표시되어 있다면 각 Viewer의 후보·Measurement 이름을 확인해 실제 계산 결과와 구분하세요. 데이터 선택과 색상·단면 조절은 [Viewer 사용법](workbench-viewer-selection.md)을 참고하세요.

## 실행 전후에 기억할 점

- **조건 수정과 실행은 별개입니다.** Vars를 바꾸거나 후보를 생성하는 것만으로 계산이 시작되지는 않습니다.
- **계산 결과는 실행 당시의 소스와 연결됩니다.** 소스를 바꿨다면 변경한 버전을 저장하고 새 Measurement를 만드세요. Recorded Measurement를 덮어쓰거나 다시 실행하지 않습니다.
- **형상만 있는 예제도 있습니다.** Task 파일이 없는 Experiment는 형상 미리보기와 저장을 할 수 있지만 Measurement 생성·선택·분석과 Simulation 실행은 사용할 수 없습니다. 첫 실행에는 Solver 작업이 포함된 예제를 고르세요.
- **실패한 작업은 자동 재실행하지 않습니다.** 원인을 확인한 뒤 CAE Jobs에서 재시도하세요. **Batch 취소**는 아직 끝나지 않은 작업을 취소합니다.

## 다음 단계

- [Measurement에서 조건 만들고 실행하기](workbench-measurement.md): 여러 후보, PCA, 예측과 실제 결과 비교를 익힙니다.
- [편집, Candidate 생성과 실행 결과의 관계](workbench-authoring-cycle.md): 무엇이 임시 상태이고 무엇이 저장되는지 확인합니다.
- [Calculation으로 결과 계산](workbench-calculation.md): 결과를 미리 보고 계산식과 후처리 데이터를 저장합니다.
- [Experiment Program의 파일과 책임](../program/program-overview.md): 예제 소스를 직접 수정하기 전에 파일 구성을 살펴봅니다.
