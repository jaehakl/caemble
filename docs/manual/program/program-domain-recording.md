# Catalog 기반 RecordedData와 Viewer

Experiment의 `recordedData`는 `결과이름: { task, output }`으로 선언합니다. `task`는 Task 파일의 이름이고 `output`은 해당 Task가 요청한 output의 `key`입니다. 결과 이름은 자유롭게 정합니다. 수동 dtype/group schema와 예약 결과 이름은 지원하지 않습니다.

공통 빌드는 Catalog output의 데이터 구조와 semantic visualization 계약을 해석하고, Task·output·Solver 버전·Catalog revision·확장된 tensor schema를 결과 계약에 고정합니다. 같은 Experiment에서 여러 Solver의 결과를 함께 선언할 수 있습니다. 실행 순서와 데이터 전달은 `simulate.py`의 `sim.run`, `sim.record`, `sim.release`가 소유합니다. `sim.record(name, artifact)`에는 선언한 Task/output에서 생성된 live artifact를 전달해야 합니다. 모양이 같은 다른 출력, 임의 값, 해제된 artifact는 거부됩니다.

Experiment와 Measurement 결과 조회, CLI 로컬 결과 및 export에는 고정된 결과 계약이 함께 제공됩니다. 저장 결과를 열 때 최신 Catalog나 편집 중인 소스로 재해석하지 않습니다. Measurement가 있는 Experiment의 계약은 변경할 수 없습니다. 새 계약이 없는 과거 데이터는 보존하지만 새 Viewer에서 미지원 상태로 표시하며 이름이나 축을 이용해 복원하지 않습니다.

Viewer의 공통 결과 선택 영역에서 Geometry와 모든 논리적 결과를 선택합니다. renderer는 결과 이름이 아닌 저장된 semantic kind로 결정합니다.

- `mesh-field`: 기록된 메쉬와 Field를 표시합니다. 성분·크기, 단면, 모서리, 범례를 제공합니다. displacement 의미가 선언된 결과는 변형 배율을, stress 의미가 선언된 결과는 von Mises 표시를 제공합니다.
- `polyline`: 계약에 연결된 정점과 offset으로 경로를 구성합니다. 여러 결과를 독립적으로 선택할 수 있습니다.
- `structured-field`: 기록된 공간 축의 slice와 나머지 시간·주파수·component 축의 index를 선택합니다.
- `tensor`: chart/table/heatmap과 추가 축의 index 선택을 제공합니다.
- `bundle`: 계약에 선언된 구성 데이터를 상세 항목으로 선택합니다. stress 상세 bundle도 이 방식으로 표시합니다.

초기 Overlay는 기준 Geometry 위 mesh field 하나와 여러 polyline 결과를 지원합니다. 길이 단위를 변환하며 같은 Experiment 좌표계로 선언된 결과만 연결합니다. 현재 Geometry source 또는 Vars가 저장 결과와 다르면 Geometry Overlay를 표시하지 않습니다. 기본 Geometry는 원래 좌표이며 변형 배율이 적용된 mesh와 원래 좌표의 polyline을 동시에 표시하지 않습니다. Measurement를 바꾸면 선택과 Overlay를 초기화합니다. 개별 결과의 형식 오류는 다른 결과 조회를 막지 않습니다.

데이터 전송은 기존 tensor dtype·shape·axes 및 inline/attachment 형식을 사용합니다. 확장된 dotted tensor leaf와 ExperimentRecord ID는 Calculation에서 그대로 참조합니다. 논리적 결과의 계약 metadata는 tensor leaf가 아니며 CalculationData 후처리는 유지됩니다.

[Structural Optical Results 공식 예제](/?help=examples&item=caemble:experiment/caemble/verified/structural-optical-results@2.0.0)는 한 Experiment에서 displacement·stress-field·reaction과 서로 다른 이름의 ray 결과 두 개를 기록합니다.

## 변형 형상과 시간 이력

tet4 displacement 결과는 변형 표시와 자동 확대가 기본입니다. 자동 확대는 전체
시간 구간의 최대 변위를 원래 mesh bounding box 대각선의 10%로 맞춥니다.
화면에 표시되는 배율은 좌표에만 적용되며 물리 값과 색상 범례는 바뀌지 않습니다.
`실제 크기 1×` 또는 `직접 입력`으로 배율을 바꾸고, `원형 윤곽 비교`로 기준 mesh를
함께 볼 수 있습니다. 변형 표시에서는 원래 Geometry의 불투명 면을 숨깁니다.

stress 결과는 같은 Task와 domain, 절점 ID, 연결성, 좌표계가 확인된 정적 displacement를
선택해 변형 형상 위에 표시합니다. 후보가 하나면 자동 연결하며, 일부 영역 mesh나
서로 다른 domain은 배열 크기가 같아도 연결하지 않습니다. 과거 기록에 절점 ID가
없으면 해당 결과 자체의 변형은 볼 수 있지만 다른 stress 결과와 연결하지 않습니다.

시간 이력은 mesh와 모든 절점의 변위가 함께 기록된 결과에서 재생합니다. 일반 표면
평균 history나 최종 displacement만으로 전체 구조 애니메이션을 복원하지 않습니다.
재생은 첫 프레임에서 정지한 상태로 시작합니다. 기본 속도는 전체 구간을 5초에
보여주며 실제 시간 대비 배속을 표시합니다. 슬라이더와 이전·다음 프레임으로 저장된
시점을 선택하고, 재생·일시정지, 반복과 속도를 조절할 수 있습니다. 시간 보간은 하지
않습니다. 색상 범위와 자동 배율은 전체 구간에 고정되며 최종 stress를 과거 시점의
응력으로 표시하지 않습니다.

직접 확인하려면 Catalog의 **structural-analysis-modes** 예제를 새로 빌드·실행한 뒤
`transientAnimation` 결과를 선택합니다. 예제의 Task output과 `simulate.py`에는
전체 절점 이력을 기록하는 선언이 포함되어 있습니다. 초기 자동 확대, 실제 크기 1×,
원형 윤곽 비교, 시간 슬라이더와 재생을 차례로 확인하세요. 재생 중 카메라를 이동해도
자동으로 맞춤이 반복되지 않아야 하고, Measurement를 바꾸면 재생과 선택이 초기화되어야
합니다. `transientMesh`는 마지막 상태, `transient`는 기존 표면 history를 비교하는 데
사용합니다. 상세한 output 문법은 현재 Catalog 계약과 이 예제 소스를 기준으로 확인하세요.

## 복소수 장과 3D 단면

Spectral field는 `[frequency, z, y, x, component]` complex64 tensor 하나입니다.
시간 기록은 `[time, z, y, x, component]` float32 tensor입니다. 주파수 입력은
명시적인 `frequencies` tensor이며 입력 순서가 그대로 기록됩니다. 서로 다른
검출기와 전기장·자기장은 독립 결과로 유지됩니다. 정확한 authoring 문법은
현재 Catalog의 FDTD output 계약과 공식 예제에서 확인합니다.

complex64 원소는 실수부와 허수부를 모두 보존합니다. inline JSON은 `{ re, im }`,
binary는 little-endian float32 `[re, im]` 교차 저장으로 원소당 8바이트입니다.
복소수 표현은 shape에 축을 추가하지 않습니다. 저장·attachment·CLI export는
같은 형식을 사용하며 과거 real/imag bundle은 자동 병합하지 않습니다.

공간 의미가 기록된 structured-field는 Geometry와 같은 3D 장면의 XY·YZ·XZ
단면으로 표시합니다. 좌표와 검출 영역은 기록할 때 transform이 적용된 Experiment
좌표이며 실제 표본 간격을 사용합니다. 공간 계약이나 source/Vars가 호환되지 않으면
Geometry Overlay를 표시하지 않습니다. 과거 bundle은 구성 데이터 상세 보기를 유지합니다.

기본 표시는 전체 장 크기 `sqrt(Σ|component|²)`이며 광강도가 아닙니다.
Ex·Ey·Ez 또는 Hx·Hy·Hz를 선택하면 개별 성분을 볼 수 있습니다. 복소수 성분은
진폭·실수부·허수부·위상을 선택하며 위상은 rad로 표시합니다. 진폭 0의 위상은
미정의로 표시에서 제외합니다. 주파수는 Hz와 진공 파장을 함께 표시하고 0 Hz에는
파장을 표시하지 않습니다.

단일 표본 축이 있으면 그 검출 평면으로 시작하고 일반 격자는 중앙 Z의 XY 단면으로
시작합니다. 위치·시간/주파수·성분·투명도(기본 0.8)를 조절할 수 있습니다.
자동 색상 범위는 선택한 시간/주파수의 공간 전체에서 정해지므로 단면 이동 중에는
변하지 않습니다. 범위를 직접 고정하거나 Table / 2D 상세로 전환할 수 있습니다.
단면·주파수·성분 변경은 카메라를 자동 맞춤하지 않습니다.

직접 확인할 때는 최신 **Gold FCC Array** 예제를 열고 새 기록에서
`referenceScattered`, `incident`, `scattered`를 차례로 선택합니다. 각 결과에서
1000 nm·1500 nm, Ex·Ey·Ez와 전체 크기, 진폭·위상을 전환하세요. 기존 X 편광과
무관하게 모든 전기장 성분이 보존됩니다. Geometry 위 검출 평면 위치, 단면 투명도,
색상 범위 고정, 카메라 유지와 Measurement 전환 시 선택 초기화를 확인합니다.
과거 저장 결과에는 새 주파수·성분 계약을 소급 적용하지 않습니다.

### 주파수 성분 진동

complex64 spectral 결과의 3D 단면에서 `표시 모드 → 진동`을 선택하면 저장된
복소수 성분을 `re × cos(φ) − im × sin(φ)`로 표시합니다. 기존 DFT 계수의 크기를
그대로 사용하며 원래 광대역 펄스의 시간 이력을 복원하는 기능은 아닙니다.
전체 크기에서 전환하면 Ex 또는 Hx가 선택됩니다. 진동 모드에서는 개별 성분만
선택하며 범례는 해당 성분의 물리 단위로 표시됩니다.

처음에는 0°에서 정지합니다. 재생을 누르면 기본 한 주기 2초로 반복하며,
위상 슬라이더로 0–360°를 직접 선택하면 재생이 정지합니다. 속도는
0.25×–4×로 조절합니다. 화면의 주기 T와 상대 시간 t는 기록된 Hz를 기준으로
계산한 물리 시간이고, 재생 속도는 눈으로 관찰하기 위한 표시 속도입니다.
0 Hz는 정적 실수부만 표시합니다.

자동 범례는 공간 전체의 최대 진폭 A로 정한 `[-A, A]`이며 재생 중 고정됩니다.
모두 0이면 영장 표시와 `[-1, 1]` 범위를 사용합니다. 수동 범위는 정적 모드와
별도로 유지됩니다. 단면·성분 변경은 현재 위상을 유지하고, 주파수 변경은
정지 후 0°로 돌아갑니다. 정적 모드·2D 상세·다른 결과나 Measurement로 전환하면
재생을 중지합니다.

Gold FCC에서는 결과를 선택한 뒤 `진동`, 1000 nm 또는 1500 nm, Ex·Ey·Ez를
차례로 선택하고 재생하세요. 0°는 실수부, 90°는 허수부의 음수, 180°는 실수부의
음수입니다. 단면을 옮겨도 카메라와 범례가 자동으로 바뀌지 않는지 확인하세요.
