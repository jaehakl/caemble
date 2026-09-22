# Measurement 실행 또는 결과 오류

실행에 실패했다면 제출 전 준비, Solver 실행, 결과 저장 중 어디에서 멈췄는지 먼저 구분하세요. 같은 실행을 반복하기 전에 첫 오류와 해당 작업 상태를 확인하면 원인을 더 빨리 찾을 수 있습니다.

## 실패한 단계를 먼저 찾기

**Console**의 첫 오류와 **Setting → CAE Jobs**의 해당 작업 상태를 함께 확인하세요. 다음 표에서 증상에 맞는 항목부터 살펴봅니다.

| 증상                     | 확인 위치                            | 다음 행동                                                                    |
| ------------------------ | ------------------------------------ | ---------------------------------------------------------------------------- |
| 실행 버튼이 비활성화됨 | 로그인·저장 상태·Vars 입력 | 내 Experiment를 저장하고 미확정·잘못된 변수 입력을 해결합니다. |
| 제출 전에 실패함 | Source diagnostics·Console | 실행 입력을 만드는 과정의 오류를 수정하고 다시 제출합니다. |
| 작업이 실행되지 않음 | Setting → Launchers·CAE Jobs | 내 Launcher의 연결과 작업 상태를 확인합니다. |
| Solver 실행이 실패함 | CAE Jobs의 오류와 현재 task·method | Task 입력과 Solver 규격을 비교하고 원인을 해결한 뒤 재시도합니다. |
| 실행 후 예상 결과가 없음 | Measurement의 RecordedData·기록 선언 | 출력 이름, 기록 이름과 결과 객체의 사용 가능 기간을 확인합니다. |
| Solver는 완료했지만 Analysis 데이터가 없음 | Calculation의 후처리 상태 | Calculation을 저장하고 **All Missing** 등으로 빠진 후처리 결과를 계산합니다. |

## 입력과 기록 계약 점검

1. 로그인, 내 Experiment의 저장 상태와 CAE Launcher 연결을 확인합니다.
2. 현재 Experiment 버전의 후보 또는 결과가 아직 없는 Prepared Measurement를 선택했는지 확인합니다. Recorded Measurement는 다시 실행하지 않습니다.
3. 소스를 직접 작성했다면 Python의 task 이름이 `tasks/<name>.tsx` 파일명과 일치하는지 확인합니다.
4. 요청한 output의 key와 `result["artifacts"]`에서 가져오는 key를 비교합니다.
5. `sim.record()`에 전달하는 이름이 Experiment의 `recordedData` 이름과 같은지 확인합니다.
6. `sim.release()`로 해제한 결과 객체(artifact)를 다시 전달하거나 기록하지 않았는지 확인합니다.
7. 소스를 수정했다면 새 버전을 저장하고 새 Measurement를 준비합니다. 이전 결과는 실행 당시 버전의 기록으로 남습니다.

## 재시도와 취소

서버나 worker 연결이 끊긴 경우를 포함해 실패한 작업은 자동으로 다시 실행하지 않습니다. 원인을 해결한 뒤 **CAE Jobs**에서 재시도하세요. 소스나 입력을 바꾸어야 한다면 수정한 조건으로 새 작업을 제출합니다. **Batch 취소**는 아직 끝나지 않은 작업을 취소합니다.

서버 접수가 끝난 작업은 브라우저를 닫아도 계속되지만, 입력 준비와 업로드에는 브라우저가 필요합니다. Calculation 후처리도 브라우저에서 실행하므로 중단되었다면 [누락된 후처리 결과](../workbench/workbench-calculation.md#후처리-결과-저장)를 따로 계산하세요.

사용자가 요청한 취소는 오류와 구분되는 종료 상태입니다. 원인을 문의하거나 공유할 때는 첫 오류 메시지, 실패 단계, task·method, Experiment·Measurement·작업 ID와 소스 해시를 함께 남기세요. 내부 worker 상태나 전체 바이너리 결과를 복사할 필요는 없습니다.
