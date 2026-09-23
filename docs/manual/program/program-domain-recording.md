# 해석 결과를 기록하고 Viewer에서 확인하기

해석을 마치면 공간에 따른 수치를 읽거나, 메쉬와 광선 경로를 보거나, 결과를 계산하고 싶을 수 있습니다. 이 문서에서는 **수치 기록**, **자동 시각화**, **다음 Solver에 전달할 데이터**의 차이를 먼저 살펴봅니다. 기본 선언은 [experiment.tsx](program-definition.md), 실행과 기록 문법은 [simulate.py](program-simulate.md)를 참고하세요.

## 어떤 결과를 남겨야 하나요

| 하고 싶은 일 | 사용할 결과 |
| --- | --- |
| 수치를 저장하고 Calculation·Analysis·Prediction에 활용 | `recordedData`에 선언해 기록한 Box Grid |
| 계산 메쉬, 광선 경로, 입자의 움직임 확인 | Solver가 별도로 제공하는 자동 시각화 |
| 한 Solver의 물리 데이터를 다음 Solver로 전달 | Task의 `config.exports`로 요청한 native 데이터 |

Box Grid는 Box 안의 지정된 격자 위치에서 값을 기록하는 방식입니다. 표시용 메쉬와 같은 데이터라고 생각하지 않도록 구분해 주세요.

## 결과 선언과 저장

Experiment의 `recordedData`는 `결과이름: { task, output }` 형태로 선언합니다. `task`는 Task 파일의 이름이고 `output`은 그 Task에서 요청한 Box Grid 출력의 `key`입니다. 각 출력은 Experiment 또는 해당 Task의 Box 하나를 대상으로 지정하고 `gridShape`를 반드시 받습니다. 결과 이름은 자유롭게 정할 수 있지만 `dtype`이나 그룹 형식을 직접 선언하지는 않습니다.

공통 빌드는 카탈로그 출력의 7차원 텐서 형식과 표시 규칙을 해석하고, Task·출력·Solver 버전·카탈로그 revision을 결과 규격에 고정합니다. 같은 Experiment에서 여러 Solver의 결과를 함께 선언할 수 있습니다. 실행 순서와 데이터 전달은 `simulate.py`의 `sim.run`, `sim.record`, `sim.release`로 제어합니다. `sim.record(name, artifact)`에는 선언한 Task와 출력에서 생성되었고 아직 해제하지 않은 Box Grid 데이터를 전달해야 합니다. Solver 사이에 전달할 native field/domain은 Task의 `config.exports`로 요청하며 최종 수치 결과로 기록할 수 없습니다.

Experiment와 Measurement 결과 조회, CLI 로컬 결과 및 export에는 고정된 결과 계약이 함께 제공됩니다. 저장 결과를 열 때 최신 Catalog나 편집 중인 소스로 재해석하지 않습니다. Measurement가 있는 Experiment의 source와 계약은 변경할 수 없으므로 새 버전을 만드세요. 표준 전환 시 과거 결과·결과 계약·Calculation preflight는 초기화되며 source, Measurement vars와 material snapshot은 보존됩니다. 과거 결과를 새 축으로 자동 변환하지 않습니다.

## Viewer에서 결과 선택하기

메쉬·광선 경로는 Solver가 자동으로 제공하는 별도 시각화 데이터입니다. `outputs`나 `recordedData`에 선언하지 않으며 Calculation·Analysis·Prediction 입력에 포함하지 않습니다. 반복 실행에서는 Task마다 마지막으로 성공한 호출의 전체 시각화 스냅샷을 저장하고, 시간 이력도 그 안에 유지합니다. Viewer의 결과 선택 영역에서 형상(Geometry), Box Grid, 자동 시각화를 선택하세요. 표시 방식은 결과 이름이 아니라 저장된 데이터의 의미에 따라 결정됩니다.

- `mesh-field`: 기록된 메쉬와 Field를 표시합니다. 성분·크기, 단면, 모서리, 범례를 제공합니다. displacement 의미가 선언된 결과는 실제 크기 1×의 변형 표시를, stress 의미가 선언된 결과는 von Mises 표시를 제공합니다.
- `polyline`: 계약에 연결된 정점과 offset으로 경로를 구성합니다. 여러 결과를 독립적으로 선택할 수 있습니다.
- `particle-set`: 입자의 저장 시각·물리량 성분·ID·Material을 확인합니다. DEM의 실제 반경과 SPH·MPM의 화면 점 크기를 구분합니다. [입자 해석 안내](program-particles.md)에서 실행 예제와 제한을 확인하세요.
- `box-grid`: Histogram, Line Chart, Heatmap, 3D Point cloud로 수치 Output을 표시합니다. 채널·성분·표시 축과 나머지 축의 집계 또는 개별 index를 선택합니다.

초기 Overlay는 기준 Geometry 위 mesh field 하나와 여러 polyline 결과를 지원합니다. 길이 단위를 변환하며 같은 Experiment 좌표계로 선언된 결과만 연결합니다. 현재 Geometry source 또는 Vars가 저장 결과와 다르면 Geometry Overlay를 표시하지 않습니다. 기본 Geometry는 원래 좌표이며 변위가 적용된 mesh와 원래 좌표의 polyline을 동시에 표시하지 않습니다. Measurement를 바꾸면 선택과 Overlay를 초기화합니다. 개별 결과의 형식 오류는 다른 결과 조회를 막지 않습니다.

## 수치 데이터의 축 읽기

Box Grid 데이터는 float32 또는 float64이며 축 순서는 항상 `[x, y, z, time, frequency, amplitudePhase, component]`입니다. 앞의 세 축은 공간, 그다음은 시간·주파수, 마지막 두 축은 채널·성분입니다. 사용하지 않는 축도 길이 1로 보존합니다. 실수는 `value` 채널 하나, 복소수는 `amplitude`, `phase` 두 채널로 저장하며 위상 단위는 rad입니다. 각 RecordedData의 ExperimentRecord ID는 Calculation이 사용할 결과를 연결하는 데 쓰입니다. 자동 시각화는 별도 `/measurement/{id}/visualizations` 조회와 CLI 내보내기에 포함됩니다.

[Catalog 공식 예제](/doc?help=examples)에서 현재 Box Grid outputs와 자동 mesh·ray 시각화의 실행 소스를 확인하세요.

## 변형 형상과 시간 이력

tet4 displacement 결과는 변형 표시와 자동 확대가 기본입니다. 자동 확대는 전체
시간 구간의 최대 변위를 원래 mesh bounding box 대각선의 10%로 맞춥니다.
화면에 표시되는 배율은 좌표에만 적용되며 물리 값과 색상 범례는 바뀌지 않습니다.
`실제 크기 1×` 또는 `직접 입력`으로 배율을 바꾸고, `원형 윤곽 비교`로 기준 mesh를
함께 볼 수 있습니다. 변형 표시에서는 원래 Geometry의 불투명 면을 숨깁니다.

stress 결과는 같은 Task와 domain, 절점 ID, 연결성, 좌표계가 확인된 정적 displacement를
선택해 변형 형상 위에 표시합니다. 후보가 하나면 자동 연결하며, 일부 영역 mesh나
서로 다른 domain은 배열 크기가 같아도 연결하지 않습니다.

시간 이력은 mesh와 모든 절점의 변위가 함께 기록된 결과에서 재생합니다. 일반 표면
평균 history나 최종 displacement만으로 전체 구조 애니메이션을 복원하지 않습니다.
재생은 첫 프레임에서 정지한 상태로 시작합니다. 기본 속도는 전체 구간을 5초에
보여주며 실제 시간 대비 배속을 표시합니다. 슬라이더와 이전·다음 프레임으로 저장된
시점을 선택하고, 재생·일시정지, 반복과 속도를 조절할 수 있습니다. 시간 보간은 하지
않습니다. 색상 범위와 자동 배율은 전체 구간에 고정되며 최종 stress를 과거 시점의
응력으로 표시하지 않습니다.

직접 확인하려면 Catalog의 **structural-analysis-modes** 예제를 새로 빌드·실행한 뒤
transient Task의 자동 displacement history 시각화를 선택합니다. 전체 절점 이력은
별도 output이나 `sim.record` 선언 없이 포함됩니다. 초기 자동 확대, 실제 크기 1×,
원형 윤곽 비교, 시간 슬라이더와 재생을 차례로 확인하세요. 재생 중 카메라를 이동해도
자동으로 맞춤이 반복되지 않아야 하고, Measurement를 바꾸면 재생과 선택이 초기화되어야
합니다. 마지막 상태와 전체 시간 이력은 각 자동 시각화에서 확인합니다.
상세한 output 문법은 현재 Catalog 계약과 이 예제 소스를 기준으로 확인하세요.

## 복소수 장과 3D 단면

Spectral field와 시간 기록 모두 `[x, y, z, time, frequency, amplitudePhase, component]`
순서의 실수 tensor입니다. 주파수 입력은
명시적인 `frequencies` tensor이며 입력 순서가 그대로 기록됩니다. 서로 다른
검출기와 전기장·자기장은 독립 결과로 유지됩니다. 정확한 authoring 문법은
현재 Catalog의 FDTD output 계약과 공식 예제에서 확인합니다.

실수 장은 `amplitudePhase` 축의 `value` 하나를 사용합니다. 복소수 장은 이 축에
진폭과 위상을 저장하며 `boxGrid.channels`는 `['amplitude', 'phase']`입니다.
진폭은 장의 물리 단위, 위상은 rad이며 진폭이 0인 표본의 저장 위상도 0입니다.
저장·attachment·CLI export는 같은 7차원 형식을 사용합니다.

Box Grid의 표시 방식은 **Histogram / Line Chart / Heatmap / 3D Point cloud**에서
선택합니다. 공간 축만 사용하는 Heatmap과 3D는 저장된 Box의 origin, rotation과
길이 단위로 Geometry에 겹칩니다. x·y·z ticks는 Box local 셀 중심이며 해석
영역 밖 표본은 0입니다. Geometry와 결과의 source/Vars가 일치해야 겹칠 수 있습니다.

기본 채널은 실수 장의 Value 또는 복소수 장의 Amplitude입니다. 벡터는
절대값(크기)이나 개별 성분을 선택하고, Phase는 성분 하나의 위상을 rad로
표시합니다. 전체 크기는 `sqrt(Σ|component|²)`이며 광강도가 아닙니다.
초기 Frequency 집계는 sum, 나머지 표시하지 않는 축은 mean이므로 특정 시점·주파수·단면을 보려면
해당 축을 **개별 index**로 바꿉니다. 공간 Heatmap의 남은 공간 축을 집계하면
Box 중앙 평면에 표시합니다. 상세한 축 역할 선택과 슬라이더 조작은
[Output 시각화](../workbench/workbench-viewer-selection.md#output-시각화)를 따릅니다.

### 진동과 시간·주파수 순회

**채널** 아이콘에서 **시간 전개**를 선택하면 복소 성분을
`A_f,c × cos(φ_f,c + 2πf t)`로 표시합니다. 모든 주파수가 동일한 시간 `t`를
사용하므로 각 주파수의 위상은 주파수에 비례해 진행하며 0 Hz는 일정합니다.
Frequency sum/mean에서는 성분별 순간값을 합성한 뒤 벡터 크기를 구하고 나머지
축을 집계합니다. mean은 주파수 표본 수로 나눕니다. 저장된 진폭·위상을 그대로
사용하며 추가 주파수 가중치나 FFT 정규화를 적용하지 않습니다. 원래 펄스의
역변환을 보장하는 기능은 아닙니다. 실수부·허수부를 별도 저장 채널로 추가하지 않습니다.

x/y/z/t/f 축을 **개별 index**로 지정하면 아이콘 옆 슬라이더에서 반복 재생할 수 있습니다.
개별 comp index도 재생할 수 있으며 한 번에 한 축만 진행합니다. 재생·일시정지,
프레임·속도·반복을 조절하며 재생 중 값 범위와 카메라를 유지합니다. 진동 시간과
구간은 s로 표시하고, 기본 구간은 최저 양의 주파수 한 주기입니다. 최고 주파수
한 주기를 20프레임, 화면에서 약 2초에 재생하며 구간 길이를 직접 바꿀 수 있습니다.
반복은 구간 끝에서 0으로 돌아가며 공통 주기를 보장하지 않습니다.

Gold FCC Array의 새 결과에서 `referenceScattered`, `incident`, `scattered`를
선택하고 Heatmap의 공간 축과 frequency 개별 index를 지정하세요. 성분과
Amplitude·Phase를 바꾸고, **시간 전개** 및 **f index 재생**을
차례로 확인합니다. Geometry의 90%·50%·off 순환, 값 범위 고정과 좌표 hover 정보도 확인하세요.

### Catalog·Draft에서 임시 실행

강체 결과는 고정된 기준 mesh에 body별 위치·자세를 적용해 표시합니다.
변형 배율은 1이며, 재생 frame 사이에서 회전을 보간해 형상이 찌그러지지
않습니다. Result 선택에서 강체 운동과 기록된 밀도·속도 Grid를 확인할 수
있습니다. History의 final 출력은 마지막 수락된 출력 표본이며, 실제 호출
종료 시각의 상태는 native snapshot에 있습니다.

**Experiment 탭**에서 Catalog 예제나 Draft를 열고 Vars 준비가 끝나면
리본의 **실행**을 누릅니다. **Candidate 재생성 + 실행**은 새 Candidate의
평가·빌드가 성공한 뒤 실행합니다. 현재 설정을 그대로 사용하며 자동으로
격자·ray 수·시간 간격을 줄이지 않습니다. 로그인과 연결된 CAE Launcher가
필요하고 준비·실행 중에는 취소할 수 있습니다.

실행 중에는 이전 결과를 유지하고, 새 결과가 도착하면 Viewer의 선택·체크 설정과
카메라를 유지하며 데이터를 교체합니다. 아직 선택하지 않은 Viewer는 Geometry와
겹쳐 표시 가능한 결과를 무작위 선택합니다. 임시 결과는 실행 당시 Geometry와
Vars에 연결되며 **임시 결과 닫기**로 현재 작업 화면으로 돌아갑니다.
Experiment나 Measurement는 저장하지 않습니다. 작은 결과는 DB에, 큰 결과는
Bucket에 저장하고 완료 후 24시간이 지나면 서버가 정리합니다.

Gold FCC Array에서는 주파수·성분과 3D 단면을, Structural 예제에서는 변형과
시간 재생을 확인하세요. 데이터 교체 시 재생은 정지하고 범위를 벗어난 축·프레임은
보정됩니다. Experiment·Measurement 전환 시 임시 Viewer 상태는 초기화됩니다.

## 다음 작업으로 이어가기

화면에서 원하는 결과를 찾았다면 [Viewer 조작 안내](../workbench/workbench-viewer-selection.md)에서 축·성분·표시 방식을 자세히 확인해 보세요. 수치를 계산하려면 [Calculation](../workbench/workbench-calculation.md), 여러 조건의 경향을 비교하려면 [Analysis](../workbench/workbench-analysis.md)로 이어갈 수 있습니다.
