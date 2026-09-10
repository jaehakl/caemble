# Domain을 함께 보존하는 RecordedData

기존 tensor RecordedData는 같은 dtype·shape·axes 형식으로 기록됩니다. Solver 출력은 `recordedData`에서 `{ task: 'detail', output: 'displacement' }`처럼 참조할 수 있습니다. `task`는 `tasks/detail.tsx`의 이름이고 `output`은 해당 Task의 `config.outputs`에 지정한 `key`입니다. 이름은 실제 Task 선언과 일치해야 하며, 없는 참조는 빌드 오류입니다.

공통 빌드가 Catalog 출력 계약에서 기록 스키마를 생성합니다. 구조 체적의 node/cell Field는 메쉬·재료 영역·표면 출처·품질·지지 및 하중 위치까지 보존하고, bundle 출력은 선언된 멤버를 기록합니다. 사용자가 connectivity나 중첩 스키마를 소스 번들에 작성할 필요가 없습니다. 브라우저와 CLI는 같은 해석기를 사용합니다. `simulate.py`의 `await sim.record(name, artifact)` 호출은 유지하며 선택하지 않은 출력은 자동 기록하지 않습니다.

사용자 정의 기록에는 아래의 수동 group/leaf 선언도 계속 사용할 수 있습니다. Solver 간 전달 계약과 기록 계약은 별개이므로 기록할 항목을 명시적으로 선택합니다.

저장된 Measurement를 선택하면 중앙 Viewer에서 Geometry와 기록된 메쉬 Field를 전환할 수 있습니다. 다운로드는 최대 4개를 병렬 처리하고 진행 개수를 표시합니다. 이전 메쉬 기록에서 빠진 ordinal 축은 읽을 때만 보완하며, 원본 저장 데이터와 Experiment 소스는 수정하지 않습니다. 시간·주파수 같은 물리 좌표는 임의로 생성하지 않습니다.

- Field group: `domain`, `location`, `quantity`, `valueUnit`, `values`
- Mesh domain: `kind`, `identity`, `lengthUnit`, `points`, `cells`와 그 아래 선언한 cell block
- Structured domain: `kind`, `identity`, `lengthUnit`, `shape`, `coordinates.axis0`, `coordinates.axis1` 등의 좌표 vector
- 선택 항목: `components`, `componentBasis`, `metadata`와 `domain.metadata` 아래에 선언한 provenance

각 마지막 항목은 기존 dtype tensor descriptor로 선언합니다. `points`와 `values` 같은 float 항목에는 Catalog의 QuantityKind·unit과 필요한 basis를 지정하고, connectivity에는 integer dtype을 사용합니다. `kind`, `identity`, `location`, `quantity`, `lengthUnit`, `valueUnit`은 string 항목입니다. 없는 항목을 요청하면 기록이 실패하며, metadata는 선언한 하위 항목만 보존됩니다.

Group의 멤버 이름에 `unit`, `quantityKind`, `basis`, `axes`, `tensorOrder`를 사용하면 tensor descriptor와 충돌합니다. 단위 이름을 별도 값으로 기록할 때는 위의 `lengthUnit`·`valueUnit`, 물리량 이름에는 `quantity`를 사용하세요. 복소값은 새 dtype을 만들지 않고 실수부·허수부처럼 명시적인 기존 dtype 항목으로 기록합니다.

Recorded Data 결과 화면은 `kind`가 `unstructured-mesh`인 Field group의 실제 계산 메쉬를 표시합니다. `cells.tet4`와 절점(`node`) 또는 요소(`cell`) 값이 필요합니다. 벡터 성분·크기, 응력 성분·von Mises, 메쉬 모서리와 X/Y/Z 단면을 선택할 수 있습니다. 단면은 기록된 체적 요소를 잘라서 생성하며 새로운 해석을 실행하지 않습니다. 변위 Field는 배율을 지정해 변형 형상을 표시할 수 있고, 색상 범례에는 기록된 물리량 단위를 표시합니다.

구조 Solver가 제공하는 `domain.metadata.boundaryFaces`, `cellRegions`, `regionIds`, `supportNodes`, `loadPoints`, `loadVectors`를 함께 기록하면 경계면·재료 영역·지지점·하중 방향도 검토할 수 있습니다. 메쉬 연결 번호는 생성된 결과 내부의 식별자입니다. 사용자 task의 경계조건과 관측은 원래 Geometry의 의미 있는 면·영역을 참조하므로 메쉬 해상도가 달라져도 task를 다시 작성하지 않습니다.

브라우저와 CLI는 공통 해석 준비 프로파일로 원래 CSG 및 Fiber 함수를 조밀하게 평가합니다. 화면 미리보기의 분할 설정과 해석 형상 준비는 분리되며, 평가 프로파일과 실제 표본은 형상 hash에 포함됩니다. 형상 분할 정밀도와 Solver의 체적 메쉬 해상도는 서로 다른 단계입니다. 기록된 메쉬는 과거 계산 형상을 보존하지만 다른 실험의 checkpoint로 복원되지는 않습니다.
