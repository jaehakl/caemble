# Target, run 상태와 결과 경계

target 문자열은 `<scene>.<kind>.<group>` 형태입니다. `experiment.*`는 공통 물리 scene, `task.*`는 현재 named Task의 local scene을 가리킵니다. method manifest의 `source`와 `kind`가 target과 일치해야 합니다.

Prepared Measurement는 고정 입력 조건입니다. CAE 실행은 서버 batch의 개별 작업으로 추적하며 worker가 큰 결과를 S3에 직접 업로드하고 결과 참조가 서버에 저장되면 Measurement가 Recorded 상태가 됩니다. opaque solver state와 중간 artifact는 CAE worker 밖으로 나오지 않습니다. 브라우저는 서버에서 진행 상태와 결과 참조를 받고 큰 RecordedData 본문은 S3에서 직접 읽습니다. 기존 inline/base64 결과도 계속 읽을 수 있습니다. trace와 provenance는 진단용이며 사용자 결과 schema에 자동 추가되지 않습니다.
