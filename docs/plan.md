E:\caemble\app\ui

<Revision>
- [Problem] Reroll 을 해도 똑같은 구조만 계속 나온다.
- Viewer 에 Material Grid, Results 는 삭제한다. Geometry only, 탭 구분도 필요 없음
- Run Simulation 도 여기서 직접 하지 않도록 한다. 시뮬레이션 제어는 Toolbar 에서 하도록.

<향후 추가할 기능들 (참고 사항)>
- LLM API 기반 Structure, Experiment 소스코드 자동 생성
- Geometry Manager (현재 material 처럼 사용자 정의 Geometry 를 DB 에 등록하여 Structure, Experiment 소스코드에서 import)
- 여러 slave 를 활용한 대규모 데이터셋 병렬 생성
- Optimization
- Parameter Sweep
- DoE
- Inverse Design
- Predictor & Designer DNN Model 생성 및 활용 (gpstation 기반)
