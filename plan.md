


<데이터 후처리 기능 개발 계획>

- DB 에서 designer_model, predictor_model 테이블 삭제
- DB 에 다음 테이블 추가
    - Calculation
        - experiment_id 를 fk 로 가짐
        - source_code (text)        

[Calculation 탭]
- 기존 Measurement 탭의 이름을 Calculation 탭으로 바꿈
- 좌측 영역을 세로로 3분할하여 
    - 맨 위에는 기존 Measurement 를 점으로 표시한것 표시
    - 가운데에는 선택된 Measurement 에 포함된 RecordedData 목록을,  actual axis lengths, QuantityKind, unit 만 요약적으로 표시
    - 맨 아래에는 Calculation 목록 표시
- 우측 영역은 가로로 2분할 하여
    - 좌측에는 선택된 Calculation 의 source code Editor
    - 우측에는 해당 Calculation 에 현재 선택된 Measurement 를 넣어 낳온 Output 을 시각화한 차트 표시
- Calculation 소스코드
    - 핵심 skeleton : Measurement 의 RecordedData 를 Input 으로 받아, 0, 1, 2 차원 Tensor Data (Axis 정보 포함된, 현재 RecordedData 와 동일한 Format 내지는 Type) 를 Output 으로 내는 함수
    - stdlib.io 라이브러리 import 하여 활용



검토해보고 궁금한 점이나 보완할 점은 없는지 봐 줘.