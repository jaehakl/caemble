# simulate.py: 해석을 실행하고 결과 기록하기

Task 파일이 **무엇을 계산할지** 정한다면, `simulate.py`는 **어떤 순서로 계산하고 무엇을 남길지** 정합니다. Python 함수 `simulate(*, sim, tasks, vars)`에서 이름으로 Task를 선택해 실행합니다. 먼저 [Task 작성](program-task.md)에서 사용할 Task와 출력 이름을 확인해 주세요.

## 실행 결과의 세 가지 역할

`sim.run()`의 결과에는 다음 항목이 있습니다.

| 항목 | 용도 |
| --- | --- |
| `state` | 다음 계산을 이어갈 상태. 중첩된 값을 읽을 수 있지만 직접 수정할 수 없습니다. |
| `artifacts` | 다음 Solver에 전달하거나 최종 결과로 기록할 데이터 참조 |
| `observations` | 조건 분기 등에 사용할 작은 스칼라 값 |

## 실행·전달·기록에 쓰는 문법

- `await sim.record(name, artifact)`: 선언한 RecordedData로 기록하고 서버의 임시 저장 확인까지 기다립니다.
- `sim.release(artifact)`: 더 사용하지 않는 중간 데이터를 해제합니다.
- `sim.release(state, keep=next_state)`: 다음 계산에 필요한 상태를 남기고 이전 상태를 해제합니다.
- `inputs={port: artifact}`: 앞선 Solver의 데이터를 호환되는 입력 포트로 전달합니다.
- `state=...`: 같은 실행에서 받은, 아직 해제하지 않은 상태로 계산을 이어갑니다.

## 반복 계산에서 상태 유지하기

변경이 없는 Task는 입력과 같은 상태 참조(handle)를 돌려줍니다. 따라서 이전 상태를 무조건 해제하지 말고 `keep`으로 다음 상태를 보호하세요. 중간 저장점(checkpoint)도 남기려면 `keep=(result["state"], checkpoint)`를 사용합니다. 아래는 반복 계산의 일부이며, `state`는 앞선 `sim.run()`에서 받은 값입니다.

```python
result = await sim.run(tasks["step"], state=state)
sim.release(state, keep=result["state"])
state = result["state"]
```

## 기록을 마치기 전에 확인하기

`sim.record`의 이름은 `experiment.tsx`의 선언과 일치해야 합니다. 선언한 결과를 각각 한 번 기록하고, 소비할 Task나 기록 작업이 끝난 뒤 데이터를 해제하세요. 한 번 기록했다고 전체 실행이 성공한 것은 아닙니다. 뒤의 Task가 실패하면 임시 기록도 폐기됩니다.

[전기·열 복합해석 예제의 simulate.py 열기](/doc?help=examples&item=caemble:experiment/caemble/verified/electro-thermal-notched-bar@6.0.2)에서 실제 전달·기록 순서를 확인하세요. 설명과 함께 따라가려면 [복합해석 안내](program-multiphysics-example.md), 반복 실행이나 오류 처리가 필요하면 [상태와 데이터 수명](program-runtime-rules.md)을 읽어 보세요.
