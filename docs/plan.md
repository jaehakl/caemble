E:\caemble\app\ui

<Revision>
- 로그인하지 않은 사용자의 첫 화면에서 뭐라도 나와야 한다. 
- 로그인하지 않은 사용자라도 코드를 수정하고 구조가 바뀌는 걸 볼 수 있어야 한다.
- 로그인하지 않은 사용자라도 DB, GPStation 등이 없이도 할 수 있는 범위에서는 최대한 많은 기능들을 체험할 수 있어야 한다.
- 코드에디터의 각 파일들에 필수 모듈들 import, 최소 골격 만 떠 있는 빈 experiment 화면으로 언제든 돌아갈 수 있도록 해야 한다.
- AI Helper 는 팝업모달이 아니라 작업 탭으로 띄우도록 하자.



다음에 대해 고민해보자.

<AI Helper 의 Agent화>
- Material Parameters, Quantitykind 카탈로그들을 RAG 로
    - CODEX 에서 새 Solver 를 제작할 때 참고하기 편리해야 함
    - (로컬 텍스트 파일, Sqlite 등 로컬 DB 파일, caemble 전체 클라우드 DB 에 통합 중 로컬 CODEX Agent 가 접근하기 가장 효율적인 방식으로)
- AI Helper 가 Experiment 소스코드 번들을 직접 정확하게 만들 수 있는 RAG 구축
    - 수백가지 Solver 들의 method, material parameter, quantitykind 등 api 를 정확하게 조회할 수 있도록
        - (완벽하게 작동이 보장되려면 Solver 소스코드를 직접 보여주는 게 확실하겠지만, 수백가지 소스코드 전체를 직접 검토하기는 아마 무리가 아닐까?)
    - DB 에 등록된 Material, Geometry, Experiment 들에 대해서도 효율적으로 조회할 수 있도록





<향후 추가할 기능들 (참고 사항)>
- LLM API 기반 통합 Experiment source bundle 자동 생성
- Geometry Manager (현재 Material처럼 사용자 정의 Geometry를 DB에 등록하여 Experiment에서 import)
- 여러 slave 를 활용한 대규모 데이터셋 병렬 생성
- Optimization
- Parameter Sweep
- DoE
- Inverse Design
- Predictor & Designer DNN Model 생성 및 활용 (gpstation 기반)
