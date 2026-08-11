E:\caemble\app\ui

cae 페이지를 만든다. 이 페이지는 거의 모든 CAE 기능들을 사용할 수 있는 SPA 처럼 기능한다.
- 중심 데이터는 Structure + Experiment pair 이다. 이것들이 각각 DB 에 저장된 상태 그대로인지, 편집 중인지에 따라 동작이 달라진다.
- 파일은 여러 개로 쪼개서 읽기 쉽고 유지보수와 확장이 용이하도록 만든다.

<레이아웃(데스크탑 화면 기준)>
- 데스크탑 CAE 워크벤치처럼 상단에 Menubar 및 Toolbar, 리본메뉴를 갖는다.
- Toolbar 는 Menubar 의 Menu들 중 자주 쓰이는 기능들을 작은 아이콘 + Tooltip 으로 바로 클릭할 수 있게 만드는 것이다.
- 리본메뉴 구성은 현재 어떤 기능 탭에 Focus 되어 있는지에 따라 달라진다.
- 그 아래, 본문 영역
  - 좌측은 항상 3D CAD Viewer 가 구조를 보여주며, (Viewer 영역)
  - 우측은 로드된 기능들과 관련된 다양한 탭들이 놓인다. (Editor 영역)
    - 탭은 Menubar 에서 찾아서 추가할 수도 있고, 끌 수도 있다. 드래그하여 위치를 바꿀 수도 있다. 

<Menubar 기능>

# Source
- Research
  - New Research:  [팝업모달] 여기서 Example Structure + Experiment pair 들 제안 
  - Load Research: [팝업모달] (Measurement 에 한 번 이상 등장한 Structure + Experiment pair 목록 조회, 적절한 Search, Filter, Sort, Pagenation ui)
- Structure
  - New Structure : [팝업모달] 여기서 Example Structure 들 제안
  - Load Structure : [팝업모달](목록 조회, 적절한 Search, Filter, Sort, Pagenation ui)
  - Other Structures : [팝업모달] 현재 Experiment 와 같이 등장한 적 있는 다른 Structure 목록 조회 및 선택
  - Structure History : [팝업모달] 족보 확안 및 선택
  - Save Structure : [팝업모달] 족보 확인 및 child 로 저장
  - Save Structure as : [이름 입력] (아예 다른 계보로 시작)
- Experiment
  - New Experiment : [팝업모달] 여기서 Example Experiment 들 제안
  - Load Experiment : [팝업모달] (목록 조회, 적절한 Search, Filter, Sort, Pagenation ui)
  - Other Experiments : [팝업모달] 현재 Structure 와 같이 등장한 적 있는 다른 Experiment 목록 조회 및 선택
  - Experiment History : [팝업모달] 족보 확안 및 선택
  - Save Experiment : [팝업모달] 족보 확인 및 child 로 저장
  - Save Experiment as : [이름 입력] (아예 다른 계보로 시작)
- Material
  - Material Manager : [팝업모달] Material 목록 조회 및 편집

# Data
- Sample
  - Generate Sample : 현재 Structure 로 Sample 생성 및 저장
  - Select Sample : [팝업모달] 현재 Structure 에 저장된 Sample 목록 조회 및 선택
- Setup
  - Generate Setup : 현재 Experiment 로 Setup 생성 및 저장
  - Select Setup : [팝업모달] 현재 Experiment 에 저장된 Setup 목록 조회 및 선택
- Measurement
  - Perform Measurement : 현재 Sample + Setup 으로 Measurement 수행 및 저장
  - Generate Measurement : 현재 Structure + Experiment 로 Sample, Setup 생성 후 바로 Measurement 수행 및 저장
  - Select Measurement : [팝업모달] 현재 Structure + Experiment 조합에 저장된 Measurement 목록 조회 및 선택
  - Analyze Measurements : [팝업모달] 현재 선택된 Structure + Experiment 조합에 대한 데이터 분석

<Menubar 기능 (탭)>
- Structure : 소스코드 Editor
- Experiment : 소스코드 Editor (Task 등 여러 파일은 탭 내의 탭에서 전환한다.)
- RecordedData : 현재 선택된 Measurment 에 (Sample + Setup 조합)에 RecordedData 가 있으면 해당 데이터 표시

<향후 추가할 기능등 (참고 사항)>
- LLM API 기반 Structure, Experiment 소스코드 자동 생성
- Geometry Manager (현재 material 처럼 사용자 정의 Geometry 를 DB 에 등록하여 Structure, Experiment 소스코드에서 import)
- 여러 slave 를 활용한 대규모 데이터셋 병렬 생성
- Optimization
- Parameter Sweep
- DoE
- Inverse Design
- Predictor & Designer DNN Model 생성 및 활용 (gpstation 기반)
