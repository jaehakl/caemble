# CAD element 추가하기

각 CAD 태그는 역할에 따라 `primitives` 또는 `operations` 아래의 자체 디렉터리에서 공개 형태와 실행 코드를 분리합니다. `definition.ts`는 props 타입과 authoring metadata를 내보내며 JSCAD를 import하지 않습니다. `runtime.ts`는 신뢰된 props로 Geometry를 생성합니다. element 고유 props만 metadata에 기록하고 공통 `id`, `position`, `rotation`, `scale` 설명은 `authoringContract.ts` 한 곳에서 관리합니다. Primitive의 `authoringName`은 PascalCase이고 operation은 registry `tag`와 같은 lowercase 이름을 사용합니다. 전용 transform wrapper처럼 공통 transform을 받지 않으면 `standardTransforms: false`로 선언합니다.

- `primitives`: 자식 Geometry 없이 stand-alone solid를 생성합니다.
- `operations`: 하나 이상의 자식 Geometry를 평가해 파생 Geometry를 생성합니다.

새 element를 추가할 때는 다음 순서를 따릅니다.

1. 역할에 맞는 `primitives/_template` 또는 `operations/_template`을 복사해 `elements/<group>/<tag>/definition.ts`와 `runtime.ts`를 만듭니다.
2. primitive는 `category: 'primitive'`, `kind: 'primitive'`, `createGeometry(props)`, `createSurfaces(geometry, props)`를 사용합니다. `createSurfaces`는 의미 기반 surface 목록을 반환합니다.
3. geometry operation은 `category: 'operation'`, `kind: 'operation'`, `evaluate(node, context)`와 `surfacePolicy`를 사용합니다. transform이나 복제처럼 topology를 유지하면 `preserve`, shell이나 boolean처럼 topology를 다시 만들면 `derive`를 지정합니다.
4. `elements/manifest.json`에 `authoringName`, `standardTransforms`와 definition/runtime export를 등록합니다.
5. `api/caemble-core.d.ts`에 공개 attribute 타입을 추가합니다.
6. `npm run generate:cad-api`를 실행해 registry, JSX 선언과 AI authoring reference를 갱신합니다.

공통 벡터 계산, polyline 호 길이 재샘플링, Bishop frame은 `cad/geometry`를 재사용합니다. 공통 좌표 타입은 `cad/model/types.ts`에서 가져옵니다. Material 선택과 `scale → rotation → position` 적용은 evaluation 계층의 책임이므로 element runtime에서 반복하지 않습니다.

`derive` operation은 evaluation 계층이 결과 mesh를 미세 좌표 snap 후 triangulate하고, 공유 edge와 45도 이하의 법선 변화로 surface를 다시 묶습니다. element runtime에서 이 로직을 중복하지 않습니다.
