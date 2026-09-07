# Domain을 함께 보존하는 RecordedData

기존 tensor RecordedData는 같은 dtype·shape·axes 형식으로 기록됩니다. Domain을 가진 FieldValue artifact의 좌표와 mesh까지 보존하려면 새 RecordedData group을 선언한 뒤 `await sim.record(name, artifact)`를 호출하세요. Solver 간 전달 계약과 기록 계약은 별개이므로 기록할 항목을 명시적으로 선택합니다.

- Field group: `domain`, `location`, `quantity`, `valueUnit`, `values`
- Mesh domain: `kind`, `identity`, `lengthUnit`, `points`, `cells`와 그 아래 선언한 cell block
- Structured domain: `kind`, `identity`, `lengthUnit`, `shape`, `coordinates.axis0`, `coordinates.axis1` 등의 좌표 vector
- 선택 항목: `components`, `componentBasis`, `metadata`와 `domain.metadata` 아래에 선언한 provenance

각 마지막 항목은 기존 dtype tensor descriptor로 선언합니다. `points`와 `values` 같은 float 항목에는 Catalog의 QuantityKind·unit과 필요한 basis를 지정하고, connectivity에는 integer dtype을 사용합니다. `kind`, `identity`, `location`, `quantity`, `lengthUnit`, `valueUnit`은 string 항목입니다. 없는 항목을 요청하면 기록이 실패하며, metadata는 선언한 하위 항목만 보존됩니다.

Group의 멤버 이름에 `unit`, `quantityKind`, `basis`, `axes`, `tensorOrder`를 사용하면 tensor descriptor와 충돌합니다. 단위 이름을 별도 값으로 기록할 때는 위의 `lengthUnit`·`valueUnit`, 물리량 이름에는 `quantity`를 사용하세요. 복소값은 새 dtype을 만들지 않고 실수부·허수부처럼 명시적인 기존 dtype 항목으로 기록합니다.

이 group은 좌표·connectivity·field의 관계를 데이터로 보존합니다. 범용 mesh 전용 Viewer나 기록을 다른 실험의 checkpoint로 불러오는 기능을 추가하지는 않습니다.
