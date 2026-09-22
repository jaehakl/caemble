# 편집, Candidate 생성과 실행 결과의 관계

소스를 수정하는 것, 변수 조건을 바꾸는 것, 계산을 실행하는 것은 서로 다른 작업입니다. 이 차이를 알아두면 기존 결과를 보존하면서 새 조건을 비교할 수 있습니다.

## 소스와 변수는 무엇이 다른가요?

**소스(Source)**는 형상·재료·Solver 작업을 만드는 규칙입니다. **Vars**는 그 규칙에 넣는 값이고, **Candidate**는 현재 Vars로 준비한 임시 조건입니다. 같은 소스를 사용하면서 Vars만 바꾸어 여러 조건을 비교할 수 있습니다.

| 작업 | 바뀌는 것 | Solver 실행 여부 |
| --- | --- | --- |
| 소스 수정 | 실험 설계의 새 편집 버전을 검증합니다. | 실행하지 않습니다. |
| Experiment의 **Candidate** | 허용 범위에서 새 변수 조건을 만들고 미리 봅니다. | 실행하지 않습니다. |
| Measurement의 **Vars 편집·후보 생성** | 변수값과 그 값으로 만든 형상·재료를 갱신합니다. | 실행하지 않습니다. |
| **Prepared 저장** 또는 Experiment의 **Save Current** | 현재 변수와 재료를 Measurement에 고정합니다. | 실행하지 않습니다. |
| Measurement의 **선택 Run** | 선택한 후보 또는 Prepared Measurement를 실행합니다. | 실행합니다. |

Measurement의 Vars 편집기는 스칼라와 배열 값을 지원합니다. 편집한 값으로 Viewer를 다시 만들며, 소스에 선언된 min/max 범위를 벗어난 값은 반영하지 않습니다. 자세한 조작은 [Measurement 사용법](workbench-measurement.md#vars-편집)을 참고하세요.

## 소스가 Ready가 되는 과정

소스를 수정하면 `Dirty → Checking → Compiling → Evaluating → Ready` 순서로 검증합니다. 각각 변경 감지, 기본 검사, 컴파일, 형상과 입력 평가, 준비 완료에 해당합니다.

`Error`가 보이면 diagnostics에 표시된 첫 오류의 파일명과 줄 번호부터 확인하세요. 소스를 수정한 뒤에는 변경한 버전이 Ready인지 확인하고 원하는 변수 조건으로 형상과 재료를 다시 살펴봅니다.

## 저장한 조건과 결과 보존하기

Candidate는 저장 전까지 임시 상태입니다. 후보를 만들었다는 사실만으로 재현에 필요한 이력이나 난수 seed가 보장되지는 않습니다. 남겨야 할 조건은 **Prepared 저장**으로 변수와 재료를 고정하세요.

실행을 마쳐 Recorded 상태가 된 Measurement는 다시 실행하지 않습니다. 소스를 바꾸었다면 변경된 Experiment 버전을 저장한 뒤 새 Measurement를 준비합니다. 다른 조건을 비교할 때도 기존 결과를 덮어쓰지 않고 새 후보에서 시작하세요.

Prediction의 **Save & Run**은 화면에서 확인한 현재 조건을 새 Measurement로 저장한 뒤 실제로 실행합니다. 무작위 후보를 새로 만드는 동작이 아닙니다. 예측과 실제 결과의 비교 방법은 [Prediction 사용법](workbench-prediction.md#save--run-검증)을 참고하세요.
