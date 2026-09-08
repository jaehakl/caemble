# Measurement 실행 또는 결과 오류

## 실패한 단계를 먼저 찾기

**Console**에서 첫 오류를 확인하고 **Setting → CAE Jobs**에서 해당 작업의 상태와 오류를 비교하세요. 아래 표에서 실패한 단계부터 확인하면 됩니다.

| 증상                     | 확인 위치                            | 다음 행동                                                                    |
| ------------------------ | ------------------------------------ | ---------------------------------------------------------------------------- |
| 제출 전에 실패함         | Source diagnostics·Console           | 입력 build 오류를 수정하고 다시 제출합니다.                                  |
| 작업이 실행되지 않음     | Setting → Launchers·CAE Jobs         | 내 Launcher 연결과 작업 상태를 확인합니다.                                   |
| Solver 실행이 실패함     | CAE Jobs의 오류와 현재 task·method   | Task 입력과 Solver 계약을 비교하고 원인을 해결한 뒤 명시적으로 재시도합니다. |
| 실행 후 예상 결과가 없음 | Measurement의 RecordedData·기록 계약 | 출력 이름, 기록 이름과 artifact 수명을 확인합니다.                           |

## 입력과 기록 계약 점검

1. 로그인과 CAE Launcher 연결 상태를 확인합니다.
2. 현재 Experiment revision에 속하고 RecordedData가 아직 없는 prepared Measurement를 선택했는지 확인합니다.
3. Python의 task 이름이 `tasks/<name>.tsx` 파일명과 일치하는지 확인합니다.
4. output key와 `result["artifacts"]` key를 확인합니다.
5. `sim.record()` 이름과 Experiment `recordedData` 이름을 확인합니다.
6. release한 artifact를 다시 전달하거나 기록하지 않았는지 확인합니다.
7. source를 수정했다면 새 revision에서 새 Measurement를 준비해 실행합니다. 이전 결과는 해당 revision의 기록으로 남습니다.

## 재시도와 취소

실패한 서버 작업은 자동으로 다시 실행되지 않습니다. 오류 원인을 해결하고 **CAE Jobs**에서 명시적으로 재시도하세요. 소스나 입력을 변경해야 한다면 수정한 조건으로 새 작업을 제출하세요. 서버 접수가 완료된 작업은 브라우저를 닫아도 계속되지만, 로컬 build·업로드 중에는 브라우저를 유지해야 합니다.

취소는 정상적인 terminal 상태일 수 있습니다. 실패 원인을 분석할 때는 사용자에게 보이는 첫 오류와 현재 task/method를 함께 기록하고, opaque worker state나 전체 binary 결과를 복사하지 마세요.
