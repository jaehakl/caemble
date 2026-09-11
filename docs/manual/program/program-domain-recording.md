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
