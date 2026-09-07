# Measurement 실행 또는 결과 오류

1. 로그인과 CAE Launcher 연결 상태를 확인합니다.
2. 현재 Experiment revision에 속하고 RecordedData가 아직 없는 prepared Measurement를 선택했는지 확인합니다.
3. Python의 task 이름이 `tasks/<name>.tsx` 파일명과 일치하는지 확인합니다.
4. output key와 `result["artifacts"]` key를 확인합니다.
5. `sim.record()` 이름과 Experiment `recordedData` 이름을 확인합니다.
6. release한 artifact를 다시 전달하거나 기록하지 않았는지 확인합니다.
7. source를 수정했다면 stale 결과를 버리고 다시 실행합니다.

취소는 정상적인 terminal 상태일 수 있습니다. 실패 원인을 분석할 때는 사용자에게 보이는 첫 오류와 현재 task/method를 함께 기록하고, opaque worker state나 전체 binary 결과를 복사하지 마세요.
