# Target, run 상태와 결과 경계

target 문자열은 `<scene>.<kind>.<group>` 형태입니다. `experiment.*`는 공통 물리 scene, `task.*`는 현재 named Task의 local scene을 가리킵니다. method manifest의 `source`와 `kind`가 target과 일치해야 합니다.

Prepared Measurement는 고정 입력 조건입니다. CAE 실행은 서버 batch의 개별 작업으로 추적하며 worker가 큰 결과를 S3에 직접 업로드하고 결과 참조가 서버에 저장되면 Measurement가 Recorded 상태가 됩니다. opaque solver state와 중간 artifact는 CAE worker 밖으로 나오지 않습니다. 브라우저는 서버에서 진행 상태와 결과 참조를 받고 큰 RecordedData 본문은 S3에서 직접 읽습니다. 기존 inline/base64 결과도 계속 읽을 수 있습니다. trace와 provenance는 진단용이며 사용자 결과 schema에 자동 추가되지 않습니다.

주파수응답의 Box Grid는 진폭과 위상을 보존합니다. 진폭은 peak 값이며
RMS가 필요하면 단일 조화 신호에서 진폭을 `sqrt(2)`로 나눕니다. Native mesh의
주파수·위상 선택은 그 응답의 순간값을 표시합니다. 처음에는 첫 계산 주파수와
위상 0°가 선택되며 선택값을 화면에서 확인하고 변경할 수 있습니다.
비교 대상에 같은 주파수가 없으면 해당 값을 표시할 수 없음을 알립니다.

압력은 위상에 따라 양수와 음수가 되는 순간 음압입니다. 응력에 변형 형상을
겹칠 때는 같은 결과·주파수·위상의 변위를 사용합니다. 표시용 변형 배율은
기록된 물리 값이나 단위를 바꾸지 않습니다. Native 표시와 다른 Solver에
전달하는 표면 운동은 Box Grid 기록과 별개이며 Calculation·Prediction에는
선택한 수치 Record만 사용합니다.
