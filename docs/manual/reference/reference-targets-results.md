# 해석 대상과 실행 결과의 관계

Task가 어느 형상에 조건을 적용하는지, 실행 중인 데이터와 저장된 결과가 어떻게 다른지 살펴봅니다. 대상 그룹을 처음 만든다면 [형상 ID와 그룹](reference-geometry-identity.md), 실행 절차가 궁금하다면 [빠른 시작](../workbench/workbench-quickstart.md)을 먼저 읽어 보세요.

## target 주소 읽기

`target` 문자열은 `<scene>.<kind>.<group>` 형태입니다. `experiment.*`는 실험 전체의 공통 장면, `task.*`는 현재 Task의 전용 장면을 가리킵니다. 가운데 항목은 형상·표면 등 대상의 종류이고, 마지막 항목은 선언한 그룹 이름입니다. Solver 메서드에 정의된 `source`와 `kind`가 실제 대상과 일치해야 합니다.

예를 들어 `experiment.geometry.<group>`은 공통 형상 그룹, `task.geometry.<group>`은 현재 Task의 형상 그룹을 참조합니다. 문자열이 맞더라도 그룹이 의도한 형상으로 연결되는지는 Viewer에서 확인해 주세요. 정확한 허용 대상은 [Solver 카탈로그](/doc?help=solvers)를 기준으로 합니다.

## 준비된 입력과 저장된 결과 구분하기

Prepared Measurement는 실행할 입력 조건을 고정한 상태입니다. CAE 실행은 서버의 batch 안에서 개별 작업으로 추적합니다. 실행 환경(worker)이 큰 결과를 S3에 올리고 서버에 결과 참조가 저장되면 Measurement는 Recorded 상태가 됩니다.

Solver 내부 상태와 중간 데이터 참조는 CAE 실행 환경 안에서만 사용합니다. 브라우저는 서버에서 진행 상태와 결과 위치를 받고, 큰 RecordedData 본문은 S3에서 직접 읽습니다. 기존 inline/base64 결과도 계속 읽을 수 있습니다. 실행 추적(trace)과 출처 정보(provenance)는 진단용이며 사용자 결과 형식에 자동으로 추가되지 않습니다.

따라서 결과를 계산할 때는 중간 상태를 추정해 읽기보다 실제로 저장한 수치 Record를 사용하세요. 어떤 결과를 남길지는 [결과 기록 안내](../program/program-domain-recording.md)에서 확인할 수 있습니다.

## 주파수응답 결과를 읽을 때

주파수응답의 Box Grid는 진폭과 위상을 보존합니다. 진폭은 peak 값이며
RMS가 필요하면 단일 조화 신호에서 진폭을 `sqrt(2)`로 나눕니다. Native mesh의
주파수·위상 선택은 그 응답의 순간값을 표시합니다. 처음에는 첫 계산 주파수와
위상 0°가 선택되며 선택값을 화면에서 확인하고 변경할 수 있습니다.
비교 대상에 같은 주파수가 없으면 해당 값을 표시할 수 없음을 알립니다.

압력은 위상에 따라 양수와 음수가 되는 순간 음압입니다. 응력에 변형 형상을
겹칠 때는 같은 결과·주파수·위상의 변위를 사용합니다. 변형은 항상
실제 크기 1×로 표시하며 원형 표시에서는 변위를 적용하지 않습니다. Native 표시와 다른 Solver에
전달하는 표면 운동은 Box Grid 기록과 별개이며 Calculation·Prediction에는
선택한 수치 Record만 사용합니다.

비교를 시작하기 전에 **같은 물리량·단위·주파수·위상인지** 확인해 주세요. Viewer에서 조건을 바꾸는 방법은 [결과 선택 안내](../workbench/workbench-viewer-selection.md), 실행 상태가 예상과 다를 때는 [실행·결과 문제 해결](../troubleshooting/troubleshooting-runtime-results.md)을 참고하세요.
