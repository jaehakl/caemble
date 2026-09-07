# ID, group과 surface identity

`id`는 단순한 화면 label이 아니라 Geometry 결과의 identity입니다. custom `Geometry` component를 호출할 때는 `id`가 필수이고, 모든 intrinsic primitive와 operation에는 필요할 때 `id`를 줄 수 있습니다. Fragment(`<>...</>`)에는 `id`나 transform을 줄 수 없습니다.

- primitive의 `id`는 그 primitive가 만든 part를 소유합니다.
- topology를 바꾸는 `union`, `subtract`, `intersect`, `shell` 같은 operation에 `id`가 있으면 그 operation의 최종 결과가 해당 identity를 소유합니다. 피연산자 ID가 Boolean 결과의 ID라고 가정하지 마세요.
- component의 `id`는 재사용되는 subtree의 namespace/root identity가 됩니다. 같은 parent 아래의 sibling ID는 서로 달라야 합니다.
- evaluator가 component 호출의 `id`를 이미 소비하므로 받은 `id`를 leaf intrinsic에 그대로 전달하지 마세요. child에 별도 local segment가 필요할 때만 intrinsic `id`를 부여합니다.
- `geometryGroup`에는 의도적으로 부여한 결과 ID만 넣고, 실행 전에 Viewer에서 실제 resolve 결과를 확인하세요.
- CAD API v1 surface는 `<geometry-id>/surface/<non-negative-index>`로 참조합니다. 예를 들어 `conductor.body` Box leaf의 local +X slot은 `conductor.body/surface/1`입니다. leaf에 명시적 `id`를 주고 Geometry Catalog에 표시된 고정 slot을 사용하세요.
- 공식 Catalog는 각 Example의 공개 계약 v1 Version만 제공합니다. 제거된 이전 coordinate에는 alias나 redirect가 없으며 조회 시 `404 catalog_not_found`를 반환합니다.
- 한 Boolean operation은 최대 128개 operand를 받습니다. 큰 lattice를 중첩 Boolean으로 전개하면 Manifold 실행 전에 triangle 및 triangle-pair work 예산에서 거부됩니다.

중간 조립용 Fragment에 억지로 identity를 만들기보다 named `Geometry` component로 추출하세요. 반대로 solver가 최종 Boolean body 하나만 필요하면 operation에 `id`를 주는 편이 소유권이 가장 분명합니다.
