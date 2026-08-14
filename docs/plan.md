E:\caemble\app\ui

<Revision>
- 로그인하지 않은 사용자의 첫 화면에서 뭐라도 나와야 한다. 
- 로그인하지 않은 사용자라도 코드를 수정하고 구조가 바뀌는 걸 볼 수 있어야 한다.
- 로그인하지 않은 사용자라도 DB, GPStation 등이 없이도 할 수 있는 범위에서는 최대한 많은 기능들을 체험할 수 있어야 한다.
- 코드에디터의 각 파일들에 필수 모듈들 import, 최소 골격 만 떠 있는 빈 experiment 화면으로 언제든 돌아갈 수 있도록 해야 한다.
- AI Helper 는 팝업모달이 아니라 작업 탭으로 띄우도록 하자.




<향후 추가할 기능들 (참고 사항)>
- LLM API 기반 통합 Experiment source bundle 자동 생성
- Geometry Manager (현재 Material처럼 사용자 정의 Geometry를 DB에 등록하여 Experiment에서 import)
- 여러 slave 를 활용한 대규모 데이터셋 병렬 생성
- Optimization
- Parameter Sweep
- DoE
- Inverse Design
- Predictor & Designer DNN Model 생성 및 활용 (gpstation 기반)
