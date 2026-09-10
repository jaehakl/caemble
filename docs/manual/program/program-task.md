# tasks/*.tsx: solver task 선언

`defineTask({...})`는 `kernel: { name, version }`, Task 전용 `lengthUnit`과 `geometry`, 그리고 `config({ vars })`를 선언합니다. Geometry를 사용하지 않아도 현재 계약에 맞는 scene과 단위를 명시하세요.

Catalog에는 Solver 이름마다 현재 버전 하나와 그 버전에 맞는 예제를 제공합니다. 제거된 Solver 버전을 참조하는 Experiment는 오류가 나며 자동으로 새 버전을 선택하지 않습니다. 기존 source를 고치려면 현재 예제와 계약을 기준으로 새 Experiment Version을 만드세요.

`parameters`, `initializations`, `boundaryConditions`, `outputs`의 이름과 occurrence는 [Physics Catalog](/?help=solvers)의 현재 manifest가 단일 원본입니다. target은 `experiment.geometry.*`, `experiment.surface.*`, `task.geometry.*`, `task.surface.*` 중 method가 요구하는 source/kind와 일치해야 합니다.

[Electro-Thermal Notched Bar의 canonical Task source 열기](/?help=examples&item=caemble:experiment/caemble/verified/electro-thermal-notched-bar@3.0.0)

Material 역할마다 `modelGroups`에 선언된 그룹을 모두 확인합니다. 각 필수 그룹 안에서는 `oneOf`에 포함된 모델 인스턴스 하나를 선택합니다. 호환 인스턴스가 여러 개이면 `config({ vars })`의 `materialModels[role][materialName][groupKey]`에 선택한 인스턴스 이름을 지정하세요. 그룹·Material·인스턴스 이름이 틀리거나 선택한 모델이 호환되지 않으면 오류가 납니다.

RC/TRC 같은 수치 방법은 Task 설정입니다. Material의 물리 모델과 별개로 선택하며, 선택한 모델을 지원하지 않는 방법으로 조용히 대체하지 않습니다.

## 구조해석의 자동 메쉬

구조 task에는 CSG 부품과 재료, 물리 조건, 해석 종류·공간 해상도, 요청 결과를 선언합니다. 절점·요소 배열이나 수기 메쉬 생성 규칙, 단면 행렬을 작성하지 않습니다. Solver가 체적 메쉬와 연결 구속을 생성합니다. 이전 수기 메쉬 계약을 새 계약으로 자동 변환하지 않으므로 현재 Catalog 예제로 새 Version을 작성하세요.

지지·힘·압력·접촉과 관측은 `surfaceGroup` 또는 `geometryGroup`을 참조합니다. 형상의 변수나 해상도를 바꾸어도 같은 그룹의 의미를 유지할 수 있습니다. 연결·스프링의 내부 기준점은 선택한 부착 면에서 생성되고, 적층은 층별 실제 CSG 체적·재료 방향으로 표현합니다. 접합과 접촉은 다른 조건입니다. 부품이 닿는다는 이유만으로 자동 접합하지 않습니다.

화면 미리보기의 분할 수와 실제 계산 메쉬는 구별합니다. 브라우저·CLI의 공통 전처리가 원래 곡면과 Fiber 함수를 조밀하게 평가하고, 구조 Solver가 그 경계 내부를 체적 요소로 채웁니다. 미리보기의 성긴 점을 task에서 더 많은 배열로 복사할 필요가 없습니다.

정적·고유진동·주파수응답·선형 좌굴·시간해석의 지원 재료 및 비선형 조합은 현재 Solver 설명을 확인하세요. 큰 회전은 작은 변형률 탄성의 corotational 체적 경로이며, 유한변형률 소성이나 자동 보·쉘 축소를 뜻하지 않습니다. 거의 비압축성 재료, 얇은 굽힘과 응력 집중에서는 공간·시간 해상도 수렴을 확인해야 합니다.

결과의 [Domain을 함께 기록](program-domain-recording.md)하면 실제 계산 메쉬·단면·재료와 지지·하중·변위·응력을 Viewer에서 검토할 수 있습니다. 생성 번호는 해당 결과 안에서만 유효합니다. 형상 또는 해상도를 바꾸면 이전 메쉬의 checkpoint나 연성 하중을 재사용하지 않습니다.
