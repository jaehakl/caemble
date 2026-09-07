# 실행 중 state와 artifact 규칙

state와 artifact handle은 현재 run 안에서만 유효합니다. 다른 run의 handle이나 해제한 handle을 다시 사용하면 실행이 실패합니다. 해제한 state root는 새로 읽거나 다음 `sim.run()`에 전달할 수 없지만 계산 계보는 run 종료까지 남습니다.

`sim.release()`와 `keep`은 handle 하나 또는 handle을 담은 mapping/list/tuple을 받습니다. 값의 내용이 아니라 같은 state revision 또는 같은 artifact인지 비교하며, 모든 대상을 확인한 뒤 해제합니다. 시작점인 빈 state revision 0을 해제해도 다음 계산에서 계속 사용할 수 있습니다. 실행 중인 Task의 base state 해제는 거부되므로 `await sim.run()`이 끝난 뒤 해제하세요.

state 하나를 해제해도 같은 값을 사용하는 다른 state, artifact나 ACK 대기 기록은 유지됩니다. 이미 꺼낸 array를 다른 변수에 보관하면 그 참조가 남아 있는 동안 메모리도 유지될 수 있습니다. 기존 코드는 state를 자동 해제하지 않으므로, 반복 계산에서 필요 없는 과거 state는 명시적으로 해제하세요.

Solver 호출이 실패하면 해당 호출이 만든 state와 artifact를 함께 rollback합니다. sim.record() 결과는 실행이 끝날 때까지 provisional이며, 뒤 Task나 Python orchestration이 실패하면 모두 폐기됩니다. 실행 전체가 성공해야 서버가 RecordedData를 확정합니다.

time-series는 같은 이름을 반복 기록하지 말고 시간축이 있는 하나의 tensor artifact로 만드세요. 작은 반복 조건은 observation을 사용하고 큰 물리 데이터는 artifact로 전달합니다.
