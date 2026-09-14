# tasks/*.tsx: solver task 선언

`defineTask({...})`는 `kernel: { name, version }`, Task 전용 `lengthUnit`과 `geometry`, 그리고 `config({ vars })`를 선언합니다. Task Geometry는 Experiment Geometry와 별도 scene으로 평가·Build·렌더링되며 서로 겹친다는 이유로 CSG 형상을 바꾸지 않습니다. 광원·충돌체·경계조건 등의 물리적 역할과 상호작용은 Solver 계약이 정합니다.

Catalog에는 Solver 이름마다 현재 버전 하나와 그 버전에 맞는 예제를 제공합니다. 제거된 Solver 버전을 참조하는 Experiment는 오류가 나며 자동으로 새 버전을 선택하지 않습니다. 기존 source를 고치려면 현재 예제와 계약을 기준으로 새 Experiment Version을 만드세요.

`parameters`, `initializations`, `boundaryConditions`, `outputs`, `exports`의 이름과 occurrence는 [Physics Catalog](/doc?help=solvers)의 현재 계약이 단일 원본입니다. 수치 output의 target은 `experiment.geometry.*` 또는 `task.geometry.*`에서 Box 하나로 resolve되어야 하며 `parameters.gridShape`를 필수로 받습니다. 회전된 Box도 사용할 수 있습니다. 초기화·경계조건·native export는 각 method가 요구하는 geometry 또는 surface target을 사용합니다. 연성용 native 값은 `config.exports`로 요청하고 mesh·ray 표시는 자동 시각화로 제공받습니다.

[Catalog 예제에서 Electro-Thermal Notched Bar의 현재 Task source 확인하기](/doc?help=examples)

Material 역할마다 `modelGroups`에 선언된 그룹을 모두 확인합니다. 각 필수 그룹 안에서는 `oneOf`에 포함된 모델 인스턴스 하나를 선택합니다. 호환 인스턴스가 여러 개이면 `config({ vars })`의 `materialModels[role][materialName][groupKey]`에 선택한 인스턴스 이름을 지정하세요. 그룹·Material·인스턴스 이름이 틀리거나 선택한 모델이 호환되지 않으면 오류가 납니다.

RC/TRC 같은 수치 방법은 Task 설정입니다. Material의 물리 모델과 별개로 선택하며, 선택한 모델을 지원하지 않는 방법으로 조용히 대체하지 않습니다.

## 구조해석의 자동 메쉬

구조 task에는 CSG 부품과 재료, 물리 조건, 해석 종류·공간 해상도, 요청 결과를 선언합니다. 절점·요소 배열이나 수기 메쉬 생성 규칙, 단면 행렬을 작성하지 않습니다. Solver가 체적 메쉬와 연결 구속을 생성합니다. 이전 수기 메쉬 계약을 새 계약으로 자동 변환하지 않으므로 현재 Catalog 예제로 새 Version을 작성하세요.

지지·힘·압력·접촉과 관측은 `surfaceGroup` 또는 `geometryGroup`을 참조합니다. 형상의 변수나 해상도를 바꾸어도 같은 그룹의 의미를 유지할 수 있습니다. 연결·스프링의 내부 기준점은 선택한 부착 면에서 생성되고, 적층은 층별 실제 CSG 체적·재료 방향으로 표현합니다. 접합과 접촉은 다른 조건입니다. 부품이 닿는다는 이유만으로 자동 접합하지 않습니다.

화면 미리보기의 분할 수와 실제 계산 메쉬는 구별합니다. 브라우저·CLI의 공통 전처리가 원래 곡면과 Fiber 함수를 조밀하게 평가하고, 구조 Solver가 그 경계 내부를 체적 요소로 채웁니다. 미리보기의 성긴 점을 task에서 더 많은 배열로 복사할 필요가 없습니다.

정적·고유진동·주파수응답·선형 좌굴·시간해석의 지원 재료 및 비선형 조합은 현재 Solver 설명을 확인하세요. 큰 회전은 작은 변형률 탄성의 corotational 체적 경로이며, 유한변형률 소성이나 자동 보·쉘 축소를 뜻하지 않습니다. 거의 비압축성 재료, 얇은 굽힘과 응력 집중에서는 공간·시간 해상도 수렴을 확인해야 합니다.

Solver의 [자동 시각화](program-domain-recording.md)로 실제 계산 메쉬·단면·재료와 지지·하중·변위·응력을 Viewer에서 검토할 수 있습니다. Box 내부에 절점이 없어도 수치 output은 해석장 보간으로 구합니다. 생성 번호는 해당 시각화 안에서만 유효합니다. 형상 또는 해상도를 바꾸면 이전 메쉬의 checkpoint나 연성 하중을 재사용하지 않습니다.

## 강체의 자유 병진·회전

강체 task에는 Boolean CSG 형상과 균일 밀도 재료를 연결합니다. 질량·질량중심·
관성텐서는 자동 계산되므로 mesh나 관성을 직접 입력하지 않습니다. 한 root 안에
떨어진 물질이 여러 개 있으면 각각 독립 강체가 됩니다. 빈 공동의 안쪽 표면은
새 강체가 아닙니다. 열린 표면과 유효하지 않은 solid는 오류로 표시됩니다.

Root에 설정한 초기속도·각속도·하중은 분리된 각 강체에 동일하게 적용됩니다.
예를 들어 힘 10 N은 각 강체에 10 N입니다. 서로 다른 조건이 필요하면 별도
root로 선언하세요. 초기속도는 질량중심의 world 속도이며 각속도·힘·토크도
world 기준입니다. 부착점만 형상 원점 기준 body-local 좌표를 사용합니다.

내부 시간간격, 한 번의 실행 시간창, 전체 실행 시간과 출력 간격을 구분합니다.
출력 간격은 내부 시간간격의 정수배일 필요가 없습니다. 여러 번 실행할 때
이전 state를 연결하면 운동이 이어지고 질량특성을 다시 계산하지 않습니다.
시간창 끝의 부분 step이 달라지면 시간간격 수렴으로 결과를 비교하세요.

질량특성의 곡면 정밀도와 관측 Grid·subcell 정밀도는 별개입니다. 밀도 출력은
셀 안의 질량을 셀 전체 부피로 나눈 값이며, 속도 출력은 셀 안 물질의 질량가중
평균입니다. 밀도가 0인 셀의 속도 0은 빈 공간의 저장값입니다. 물체가 겹치면
질량·운동량을 더하고, 접촉·충돌 반력은 계산하지 않습니다. Subcell 정밀도를
높이며 Box가 포함한 질량의 수렴을 확인하세요.

밀도·속도·운동량 중 필요한 수치 출력만 기록할 수 있습니다. Native snapshot은
각 body의 실제 호출 종료 상태와 질량특성을 제공하고, 자동 시각화는 기준
CSG mesh를 배율 1로 이동·회전합니다. [현재 강체 예제와 정확한 Task 설정은
Catalog에서 확인하세요](/doc?help=examples).
