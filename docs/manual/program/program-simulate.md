# simulate.py: 실행, 전달, 기록

Python `simulate(*, sim, tasks, vars)`가 named Task의 실행 순서를 정합니다. `sim.run()`의 결과에는 nested 값을 읽을 수 있는 불변 `state`, 다음 Solver에 전달하거나 기록할 `artifacts`, 작은 scalar `observations`가 있습니다.

- `await sim.record(name, artifact)`: declared RecordedData로 승격하고 서버의 임시 저장 확인까지 대기
- `sim.release(artifact)`: 더 사용하지 않는 중간 artifact 해제
- `sim.release(state, keep=next_state)`: 다음 계산에 필요한 state를 보호하면서 이전 state 해제
- `inputs={port: artifact}`: producer artifact를 호환되는 consumer input port에 전달
- `state=...`: 같은 실행에서 받은 live state revision을 이어서 계산할 때 사용

변경이 없는 Task는 입력과 같은 state handle을 돌려줍니다. 반복 계산에서는 매번 이전 state를 무조건 해제하지 말고 `keep`으로 새 state를 보호하세요. checkpoint도 남기려면 `keep=(result["state"], checkpoint)`를 사용합니다. 다음 예제의 `state`는 앞선 `sim.run()`에서 받은 값입니다.

```python
result = await sim.run(tasks["step"], state=state)
sim.release(state, keep=result["state"])
state = result["state"]
```

[Electro-Thermal Notched Bar의 canonical simulate.py 열기](/docs?section=solvers&item=experiment:caemble:experiment/caemble/verified/electro-thermal-notched-bar@3.0.0)
