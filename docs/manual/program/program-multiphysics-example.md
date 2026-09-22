# 전기·열 복합해석 따라 읽기

전류가 흐르는 도체에서는 열이 발생합니다. 이 예제는 홈이 있는 막대의 전기 해석을 먼저 수행하고, 그때 발생한 줄 발열을 열 해석으로 전달합니다. **한 Task의 계산 결과를 다음 Task의 입력으로 연결하는 방법**을 익히는 예제입니다.

[Electro-Thermal Notched Bar 공식 예제 열기](/doc?help=examples&item=caemble:experiment/caemble/verified/electro-thermal-notched-bar@6.0.2)

이 문서는 예제의 실행 흐름을 설명합니다. 실제 소스, Solver 버전과 수치 조건은 위 카탈로그 예제에서 확인하세요. 파일 구성이 낯설다면 [Experiment 파일 구성](program-overview.md), Task 실행 문법이 낯설다면 [simulate.py 안내](program-simulate.md)를 먼저 읽으면 좋습니다.

## 먼저 살펴볼 파일

| 파일 | 확인할 내용 |
| --- | --- |
| `experiment.tsx` | 막대와 홈의 치수를 정하는 변수, 공통 도체 형상, 단자 표면 그룹, 저장할 결과 |
| `geometry.tsx` | 막대에서 홈을 빼는 형상 구성과 부품·표면 ID |
| `material.tsx` | 같은 재료에 전기 전도와 열 전도 모델을 함께 지정하는 방법 |
| `tasks/electric.tsx` | 전위 경계조건, 전기 해석 결과, 열 해석에 전달할 발열 데이터 |
| `tasks/thermal.tsx` | 온도 경계조건과 온도 해석 결과 |
| `simulate.py` | 전기 계산 → 발열 전달 → 열 계산 → 결과 기록 순서 |

같은 형상을 사용해도 전기 조건과 열 조건은 각 Task에서 따로 설정합니다. 재료 이름만으로 두 물성이 자동 적용되는 것은 아니므로, 각 Solver가 요구하는 모델과 계수가 재료에 있는지 확인하세요.

## 전기 해석에서 열 해석으로

1. `sim.run(tasks["electric"])`으로 전기 Task를 실행합니다. 결과에는 다음 계산에 사용할 상태(`state`)와 데이터 참조(`artifacts`)가 들어 있습니다.
2. 전기 Task가 내보낸 `jouleHeating`을 열 Task의 `heatSource` 입력에 연결합니다. 이 데이터에는 공간에 따른 발열 정보가 담겨 있습니다.
3. 열 Task가 전달받은 발열과 자체 경계조건을 사용해 온도를 계산합니다.
4. 열 계산이 끝나면 더 이상 필요하지 않은 발열 데이터를 해제합니다.
5. `experiment.tsx`에 선언한 수치 결과를 `sim.record`로 기록하고, 사용이 끝난 데이터와 이전 상태를 정리합니다.

중간 발열 데이터는 Solver 사이를 연결하는 native export입니다. 사용자가 나중에 조회할 Box Grid 결과와 역할이 다릅니다. 어떤 값을 다음 Solver에 전달할지와 어떤 값을 Measurement에 저장할지를 각각 정하세요.

> 이 예제는 전기 계산의 발열을 열 계산으로 전달하는 순서로 구성되어 있습니다. 온도 결과를 다시 전기 계산에 넣는 반복 연성을 자동으로 수행하지 않습니다. 연성의 방향과 반복 여부는 `simulate.py`에서 확인하세요.

## 실행 전후에 확인할 것

실행 전에는 Viewer에서 홈이 있는 막대 형상과 단자 표면을 확인하고, 전압·온도 입력의 **값과 단위**를 함께 읽어 보세요. 변수 이름만으로 V나 °C라고 가정하면 실제 Task 입력을 잘못 해석할 수 있습니다. 저장하며 실행하는 전체 절차는 [빠른 시작](../workbench/workbench-quickstart.md)을 따릅니다.

실행 후에는 전류밀도와 온도의 공간 분포, 전체 전류와 최고 온도 결과를 살펴보세요. 먼저 결과 이름·단위·선택한 성분을 확인한 뒤 형상과 비교하면 해석하기 쉽습니다. Box Grid에 기록한 분포와 Solver가 자동으로 제공하는 메쉬 시각화는 서로 다른 결과이므로 [결과 기록과 Viewer](program-domain-recording.md)의 구분도 확인해 주세요.

조건을 비교할 때는 먼저 하나의 변수만 바꾸고 별도 Measurement를 남기는 편이 읽기 쉽습니다. 저장된 Measurement의 조건과 결과를 기준으로 비교하고, 편집 중인 현재 소스를 과거 실행의 입력으로 해석하지 마세요.

## 다음으로 해 볼 작업

- 실행 순서와 중간 데이터 정리가 궁금하다면 [state와 artifact의 수명](program-runtime-rules.md)을 읽어 보세요.
- 결과를 수치로 가공하려면 [Calculation 안내](../workbench/workbench-calculation.md)를 참고하세요.
- 다른 물리 문제를 연결하고 싶다면 [Solver 카탈로그](/doc?help=solvers)에서 내보내는 데이터와 받는 입력의 호환 관계를 먼저 확인하세요.
