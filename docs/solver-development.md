# CAE Solver 개발 가이드

CAE Solver를 추가하거나 바꾸기 전에 이 문서와
`app/slaves/cae/AGENTS.md`를 모두 읽습니다. 사용자용 문법과 현재 예제는
Workbench의 `/docs`에서 관리합니다.

## 변경하지 않는 상위 계약

Experiment source bundle은 CAE 문제의 상위 정의 계층입니다. Solver를
추가하기 위해 이 구성을 우회하거나 별도 문제 정의 포맷을 만들지 않습니다.

```text
experiment.tsx       공통 Geometry, 변수, RecordedData
tasks/*.tsx          Solver identity, config, task-local Geometry
material.tsx         Material
simulate.py          실행 순서, state 연결, artifact coupling, record/release
```

`simulate.py`가 multiphysics orchestration을 계속 소유합니다. 예를 들어
전기 해석 결과를 열 해석으로 전달할 때 기존 호출 형태를 그대로 사용합니다.

```python
electric = await sim.run(tasks["electric"])
thermal = await sim.run(
    tasks["thermal"],
    state=electric["state"],
    inputs={"heatSource": electric["artifacts"]["jouleHeating"]},
)

await sim.record("temperature", thermal["artifacts"]["temperature"])
sim.release(electric["artifacts"]["jouleHeating"])
```

`state`는 계산 계보를 잇고, 실제 Solver 간 물리량 전달은 Catalog에 선언한
output과 typed input port로 표현합니다. Experiment bundle과
`sim.run`/`sim.record`/`sim.release` API는 Runtime이나 Solver 내부 구조를
바꾸더라도 호환성을 유지해야 합니다.

`simulate.py`는 Python AST allowlist 아래에서 실행되고, 현재
BuiltMeasurement에 등록된 task만 `sim.run()`에 전달할 수 있습니다. 이
allowlist는 신뢰 가능한 Experiment program과 worker API 사이의 guardrail이지
OS sandbox가 아닙니다. Run/job ownership, progress, cancellation, record ACK와
cleanup lifecycle은 resident Runtime이 소유하며 Solver가 우회하지 않습니다.

## 3계층 구조와 의존 방향

CAE worker 코드는 다음 세 계층으로 나뉩니다.

```text
app/slaves/cae/app/
├─ runtime_kernel/
│  ├─ api/             Solver ABI, StatePatch, 독립적인 DomainValue/FieldValue, 단위 계약
│  ├─ coordinator/     RunPlan/TaskSpec, SimulationApi, program, commit/rollback
│  ├─ execution/       spawn child, IPC, mmap serialization
│  ├─ resources/       state, artifact, buffer, cache
│  ├─ catalog/         descriptor snapshot과 locator 조회
│  └─ transport/       GPStation handler, 기록 schema 변환, record ACK lifecycle
├─ methods/
│  ├─ geometry/        canonical geometry와 provenance
│  ├─ structured/      Box, Field, Partition, Halo, Stencil, voxel domain
│  ├─ mesh/            unstructured topology
│  ├─ fields/          domain-bound field
│  ├─ finite_difference/
│  ├─ finite_volume/
│  ├─ finite_element/
│  ├─ assembly/
│  ├─ linalg/
│  ├─ nonlinear/
│  ├─ time/
│  ├─ coupling/        interpolation과 conservative projection
│  ├─ rays/
│  └─ optics/
└─ solvers/
   └─ <solver_package>/v<major>_<minor>_<patch>/
      ├─ entry.py
      ├─ domain.py
      ├─ formulation.py
      └─ outputs.py
```

Solver의 공개 의존 방향은 `runtime_kernel.api <- methods <- solvers`입니다.
Runtime 내부의 `resources`는 자원 그래프와 lease를 소유합니다. 신규 Solver는
Store를 생성하거나 `ResourceRef`를 입출력 값에 넣지 않습니다.

- resident `coordinator`, `transport`는 `methods`나 `solvers`를 import하지
  않습니다. Catalog locator의 구현 모듈은 spawn된 child에서만 import합니다.
- Solver가 필요한 method를 직접 고릅니다. Runtime에 framework selector나
  Solver별 중앙 분기를 추가하지 않습니다.
- Method에는 `SolverInvocation` 전체가 아니라 mesh, field, operator처럼
  계산에 필요한 값을 명시적으로 전달합니다.
- Solver 고유 config 해석, constitutive model, boundary condition과 output
  구성은 해당 Solver package에 둡니다.
- `methods.structured.Box`는 field와 partition을 조립하는 작은 composition
  root입니다. `cal_E` 같은 계산 연산은 외부 함수나 객체로 주입하며 거대한
  Framework base class로 옮기지 않습니다.

CAE의 `app/runtime.py`, `kernels.py`, `program.py`, `handlers.py`와 기존
`solver_framework` import는 이전 구현을 위한 compatibility facade일 수
있습니다. 신규 코드는 `runtime_kernel`과 역할별 `methods` package를 직접
사용합니다.

`RunPlan`은 Measurement 준비 시 normalized config, frozen descriptor, locator,
ABI, output 계약과 world snapshot을 `TaskSpec`으로 고정합니다. 각 호출은
등록된 task identity로 spec을 선택하며, 실행 때 Catalog나 다른 객체의 private
dictionary를 다시 조합하지 않습니다. `coordinator/commit.py`는 결과 검증,
state/artifact 등록과 mmap transaction 확정의 실패 복구를 한 경로로 수행합니다.

## 기본 원칙

- QuantityKind, Material, Solver, Experiment 데이터의 단일 원본은
  `app/catalog/caemble_catalog/catalog.sqlite3`입니다.
- Experiment와 Solver의 SemVer는 공개된 동작을 식별합니다. 이미 publish된
  `(name, version)`의 계약과 locator를 고치지 않고 새 SemVer로 clone합니다.
  기존 Experiment bundle이 참조하는 버전은 source 변경 없이 계속 실행할 수
  있어야 합니다.
- CAD, Geometry, Simulation, Material, Catalog, built Measurement payload는
  저장소 내부 생산자가 만든 신뢰 가능한 unversioned 데이터입니다. CAE
  worker에 별도 포맷 게이트, 중복 비즈니스 규칙, 입력 크기 제한을 만들지
  않습니다.
- Catalog 편집에는 raw SQL이나 별도 JSON/TS/Markdown 원본을 사용하지
  않습니다. 중앙 registry 분기나 Solver용 `manifest.json`도 만들지
  않습니다. `app/slaves/cae/manifest.json`은 launcher executable
  manifest이므로 유지합니다.
- 재현 가능한 상태와 artifact만 Runtime resource로 반환합니다. PCG 임시
  벡터, factorization, BVH traversal stack, CUDA context 같은 재생성 가능한
  값은 child workspace나 evictable cache에 둡니다.

## Draft SQLite와 publish

Catalog 작업은 `app/catalog`에서 canonical 파일의 별도 Draft를 만든 뒤,
모든 명령에 같은 Draft 경로를 명시합니다. canonical SQLite를 raw SQL로
직접 수정하지 않습니다.

```powershell
Push-Location app/catalog
$catalog = "caemble_catalog/catalog.sqlite3"
$draft = ".catalog-work/solver-name-1.1.0.sqlite3"

poetry run catalogctl --database $draft draft create --source $catalog
poetry run catalogctl --database $draft query solver
```

신규 Solver는 ABI 2 locator와 함께 생성합니다.

```powershell
poetry run catalogctl --database $draft solver create `
  "solver-name" "1.0.0" `
  --implementation "app.solvers.solver_package.v1_0_0.entry:implementation" `
  --implementation-abi 2 `
  --description "Solver description"
```

공개 계약을 변경한다면 기존 버전을 clone하고 새 버전의 versioned entry로
locator를 바꿉니다.

```powershell
poetry run catalogctl --database $draft solver clone `
  "solver-name" "1.0.0" "1.1.0"

poetry run catalogctl --database $draft solver set-metadata `
  "solver-name" "1.1.0" `
  --implementation "app.solvers.solver_package.v1_1_0.entry:implementation" `
  --implementation-abi 2
```

이어지는 `solver parameter`, `material-role`, `material-property`, `method`,
`method-parameter`, `input-port`, `observation`, `set-metadata` 명령도 모두
동일한 `--database $draft`를 사용합니다. Output method와 input port에는
canonical artifact type을 선언하고, producer와 consumer가 같은 물리 계약을
공유하게 합니다. 작업 중 descriptor와 artifact type projection은 CLI로
확인합니다.

```powershell
poetry run catalogctl --database $draft query solver "solver-name" "1.1.0"
poetry run catalogctl --database $draft query artifact-type
```

완성된 Draft를 명시적인 canonical destination으로 publish합니다.

```powershell
poetry run catalogctl --database $draft publish --destination $catalog
Pop-Location
```

Publish는 destination을 원자적으로 교체합니다. 배포 시 API, UI, resident
CAE worker가 같은 Catalog release를 사용해야 하므로 worker를 다시
시작합니다. 과거 버전을 참조하는 verified Experiment를 새 Solver 버전으로
임의 재지정하지 않습니다.

## Solver descriptor

Catalog descriptor가 다음 경계를 소유합니다.

- Solver 이름, SemVer, 설명, implementation locator와 ABI version
- reference length unit과 일반 parameters
- initialization/output methods와 method parameters
- Geometry/material input ports와 typed artifact input ports
- material roles와 필요한 Material properties
- observations, output QuantityKind와 artifact contract
- 선택 가능한 설정을 위한 metadata

Experiment 예제에서는 Solver, method, QuantityKind, Material role 같은
Catalog 식별자를 문자열 literal로 적습니다. 수치 입력과 일반 설정은
계산식이어도 됩니다. Detector의 총 검출 파워처럼 복사 에너지인 출력에는
`optics.RadiantFlux`를 사용합니다.

ABI 2 implementation locator는 다음 형식을 사용합니다.

```text
app.solvers.<package>.v<major>_<minor>_<patch>.entry:implementation
```

`entry.py`는 Catalog가 가리키는 유일한 공개 진입점입니다. Locator는 metadata
일 뿐 parent registry에서 import하지 않습니다. Solver별 조건문을
`runtime_kernel/coordinator/kernels.py`나 다른 중앙 모듈에 추가하지
않습니다.

## ABI 2 구현 경계

신규 Solver는 `SolverImplementation`을 export합니다.

```python
from app.runtime_kernel.api import SolverImplementation, SolverInvocation, SolverResult


async def run(invocation: SolverInvocation) -> SolverResult:
    # domain.py, formulation.py, outputs.py와 필요한 methods를 조합한다.
    ...


implementation = SolverImplementation(abi_version=2, run=run)
```

`SolverInvocation`은 호출마다 다음 값을 제공합니다.

- normalized task config와 task identity
- common/task scene 및 frozen Material snapshot을 포함하는 world
- immutable input으로 취급해야 하는 detached `Mapping` state
- Catalog input port 검증을 마친 `InputArtifact`
- child에서 바인딩한 canonical `GeometryService`
- progress callback과 cooperative cancellation token
- Solver descriptor
- run-scoped geometry cache 경로와 child-local workspace 같은 resource service

`SolverResult`에는 세 범주만 반환합니다.

```python
return SolverResult(
    state_patch=patch,
    artifacts={"outputName": output_value},
    observations={"iterationCount": iteration_count},
)
```

- `state_patch`: 이후 계산이 이어받을 재현 가능한 상태 변경
- `artifacts`: 요청된 output method와 정확히 일치하는 큰 결과
- `observations`: Catalog에 선언된 작은 scalar/string/boolean 값

Solver는 파일 시스템, 네트워크, 프로세스 전역 mutable state나 이전 child의
메모리에 결과 정합성을 의존시키지 않습니다. GPU/device 객체는 child-local로
유지하고 공유할 결과만 host resource로 반환합니다.

기존 `async run(SolverContext) -> dict` locator는 child의
`LegacySolverAdapter`가 ABI 2 결과로 변환합니다. Legacy adapter는 기존
Experiment를 위한 이관 경계이지 신규 Solver 작성 방식이 아닙니다. 새
version을 만들 때는 versioned `entry.py:implementation`으로 이동합니다.

## State revision

모든 Solver 호출은 하나의 state revision 위에서 실행됩니다. 별도의
“stateful Solver” 분류는 두지 않습니다.

- `sim.run()`에 state를 전달하지 않으면 run-scoped empty revision을
  사용합니다.
- 입력 state는 immutable `Mapping` snapshot입니다. nested mapping, list,
  scalar, tensor를 읽고 조합할 수 있지만 item mutation은 AST 정책에서도
  허용하지 않습니다.
- Solver는 입력 mapping을 제자리 수정하지 않고 `StatePatch.put`,
  `StatePatch.delete`, `StatePatch.replace`로 변경을 반환합니다.
- 빈 patch는 입력 revision과 같은 handle을 그대로 계승합니다.
- 같은 base revision에서 서로 다른 patch를 commit하면 revision DAG에
  자연스러운 branch가 생깁니다.
- `sim.run(state=...)`에는 같은 Measurement run의 이전 `sim.run()`이 반환한
  live state root만 전달할 수 있습니다. State는 run 밖으로 유출하거나
  영속화하지 않습니다.

Legacy Solver가 기존 state mapping 자체를 반환하면 빈 patch로, 새 dict를
반환하면 root replacement patch로 변환합니다. 따라서 기존
`result["state"]["rayPaths"]` 같은 Mapping 읽기도 유지됩니다.

`StateRevision`에는 revision ID, parent revision과 producer task만 남습니다.
live root와 lease는 별도로 관리하므로 명시적으로 state를 해제해도 계산 계보는
run이 끝날 때까지 보존됩니다. 기존 program의 과거 revision을 자동 해제하지
않습니다.

`sim.release(state, keep=next_state)`는 이전과 다음 revision이 같으면 아무것도
해제하지 않습니다. checkpoint까지 보호하려면 `keep=(next_state, checkpoint)`를
사용합니다. state/artifact 또는 이를 담은 mapping/list/tuple을 받을 수 있으며,
보호할 handle도 같은 형식입니다. 비교 기준은 내용 동등성이 아닌 Store와
revision/artifact ID입니다. 모든 대상을 먼저 검사한 뒤 해제합니다.

해제된 state root의 새 읽기와 `sim.run(state=...)`는 거부됩니다. 이미 꺼낸
array의 일반 Python 참조는 그대로 유효하며, 그런 참조가 있으면 mmap도 남을
수 있습니다. run의 시작점인 empty revision 0의 해제는 no-op입니다. 호출 중인
base state의 해제는 거부하고, invocation이 끝난 후 해제할 수 있습니다. 따라서
빈 patch가 기존 live handle을 반환하는 계약을 유지하며 해제된 handle을
다시 활성화하지 않습니다.

## Resource와 typed artifact

State와 Artifact의 실제 값은 resident coordinator가 소유하는 공통
`ResourceStore`에 저장됩니다. Resource tree는 scalar, mapping, sequence,
tensor뿐 아니라 structured grid, unstructured mesh, field, particle set,
ray set, structured bundle을 표현할 수 있습니다.

Solver 경계에서는 `StructuredGridValue`, `UnstructuredMeshValue`,
`ParticleSetValue`, `RaySetValue`, `FieldValue`, `BundleValue`를 사용합니다.
`FieldValue.domain`은 실제 domain 값이고, 좌표·connectivity·위치·QuantityKind·
unit·basis/components·values를 다른 child가 Store 조회 없이 해석할 수 있습니다.
부모는 이를 내부 domain/field node와 `ResourceRef`로 변환합니다. 기존
structured-field/ray-path mapping은 compatibility 경계에서 기존 표현으로
유지합니다.

StatePatch와 여러 Artifact를 한 번에 ingest할 때 동일한 domain과 array의
공유 관계를 보존합니다. mmap으로 전달된 배열은 backing buffer를 재사용하며,
Python 객체 identity가 바뀌어도 별도 buffer 사본을 만들 필요가 없습니다.
값이 같다는 이유로 모든 배열을 전역 해시하여 합치지는 않습니다.

`ArtifactHandle`은 다음 provenance를 갖는 run-scoped typed export입니다.

- unique artifact ID
- producer task, Solver name/version과 output name
- canonical artifact type
- produced state revision
- shared resource reference

Coordinator는 요청하지 않은 output, 누락된 output, 잘못된 artifact type과
관측값을 commit 전에 거부합니다. Consumer는 Catalog input port로 받은
`InputArtifact.value`를 사용합니다. 서로 다른 domain의 field를 shape만 보고
reshape하지 않고 해당 domain에 맞는 명시적인 coupling method를 적용합니다.
현재 제공하는 보존형 method의 지원 범위는 아래의 scalar cell average입니다.
같은 domain이면 backing resource를 복사하지 않고 사용할 수 있습니다.

`sim.release(handle)`는 해당 artifact 또는 state root의 lease를 해제합니다.
같은 Resource를 다른 state,
다른 artifact, 실행 transaction 또는 RecordPacket이 참조하면 실제 buffer는
남습니다. `sim.record()`는 브라우저 ACK가 끝날 때까지 별도 lease를 잡은 뒤
해제하므로 Solver나 `simulate.py`가 array를 `resize(0)` 하거나 dict를
`clear()`해서 수명을 관리하지 않습니다. Released/foreign handle과 다른
Measurement run의 state는 거부됩니다.

## RecordedData 변환 경계

`transport/recording.py`는 live artifact를 선언된 기록 schema의 값 트리로
변환하고, 기존 `tensor.py`는 inline tensor 또는 binary attachment를 만듭니다.
Solver output 계약과 RecordedData schema는 별개입니다. 기존 dtype leaf는
values와 structured axes를 기존 wire 형식으로 기록합니다.

domain을 보존하려면 새 group schema에 `domain`, `location`, `quantity`,
`valueUnit`, `values`를 명시합니다. mesh domain은 `kind`, `identity`,
`lengthUnit`, `points`, `cells`를 제공하고, named cell block은 `cells` 아래에
선언합니다. structured domain은 `shape`, `coordinates.axis0`,
`coordinates.axis1` 등의 좌표 vector를 제공합니다. 선택한 `components`,
`componentBasis`, `metadata`와 domain provenance도 선언한 하위 멤버만 기록하며,
없는 값을 요청하면 기록이 실패합니다.

Float leaf에는 기존 QuantityKind·unit·필요한 basis를 선언합니다. group의
멤버 이름으로 `unit`, `quantityKind`, `basis`, `axes`, `tensorOrder`를 사용하면
기존 authoring descriptor와 충돌하므로 위의 projection 이름을 사용합니다.
이 확장은 worker 기록의 의미 보존을 제공하며 범용 mesh viewer나 영속 checkpoint
복원을 추가하지 않습니다. complex tensor dtype은 추가하지 않고, 필요한
실수부·허수부를 명시적인 기존 dtype leaf로 기록합니다.

## 호출별 process transaction

각 `sim.run()`은 같은 Python 환경의 새 `spawn` child 하나에서 실행됩니다.
Resident coordinator는 GPStation session, `simulate.py`, authoritative state,
artifact lease, RecordedData ACK와 run cleanup을 계속 소유합니다.

```text
resident coordinator
  1. base state와 typed inputs 검증
  2. provisional mmap/resource transaction 생성
  3. spawn child 시작
  4. child 안에서 locator와 Solver module import
  5. progress/cancellation IPC
  6. SolverResult와 descriptor contract 검증
  7. state와 artifacts commit 후 mmap transaction commit
  8. child 종료 및 호출 workspace 정리
```

큰 CPU NumPy array는 parent가 소유하는 file-backed mmap buffer로 전달합니다.
base state와 input artifact는 호출별 독립 lease로 commit/rollback까지 유지합니다.
Child crash, timeout, validation failure나 cancellation이면 provisional buffer와
결과를 rollback합니다. 먼저 cancellation token으로 cooperative cancel을
요청하고 grace period에도 종료하지 않으면 그 child만 terminate합니다.
CPU-bound Solver 실패나 취소 때문에 resident worker 전체가 종료되어서는 안
됩니다.

각 child에는 임시 workspace가 하나씩 제공됩니다. Geometry triangulation과
mesh는 process-local singleton이 아니라 Measurement run의 file-backed
immutable cache를 사용할 수 있습니다. Canonical cache key에는
`geometryHash`, `rootId`, reference unit, representation kind, backend version,
meshing profile이 포함됩니다. Cache miss는 child가 계산해 원자적으로
publish하며, 손상되거나 없는 entry는 miss로 다시 계산합니다. Cache는 성능
최적화일 뿐 결과 정합성의 전제가 아니며 run 종료 시 정리됩니다.

## Geometry, field와 단위

Solver 입력은 authoring JSX나 preview mesh가 아니라 built Measurement의
canonical Geometry scene입니다. 공통 장면은 `experiment`, task별 장면은
`task` scope로 전달됩니다. Solver는 child에 주입된 Geometry service에
root의 triangular mesh를 요청합니다.

Surface group selector의 `rootId`, `sourceNodeId`, 숫자 `surfaceIndex`는
canonical provenance입니다. `surfaceIndex`는 primitive가 정한 숫자
slot입니다. Triangle 순서로 표면을 재식별하거나 Solver별 triangulation
경로를 만들지 않습니다. Transform과 Boolean을 거친 뒤에도 provenance로
emitter, detector와 boundary를 찾습니다.

길이는 descriptor의 reference unit으로 Solver-local 변환합니다. Material
property도 QuantityKind 차원에 따라 local unit으로 변환합니다. 이 변환은
저장된 Geometry와 frozen Material snapshot을 수정하지 않습니다.

물성의 값 읽기·단위 변환과 3×3 tensor의 `trace / 3` scalar 환산은 별도
책임입니다. 환산은 이를 사용하는 numerical method에서 명시적으로 수행하며
기존 수치 가정을 일반적인 Runtime 물성 조회 속에 숨기지 않습니다.

Structured field를 내보낼 때는 계산 domain identity를 함께 구성합니다.
예를 들어 DC의 Joule heating과 Heat의 source field는 동일 domain이면 값을
그대로 공유하고, domain이 다르면 conservative projection을 거칩니다.
새 Solver에서 shape가 같다는 이유만으로 서로 다른 grid/mesh의 field를
결합하지 않습니다.

`methods.coupling.values`의 `project_structured_scalar_cell_averages`와
structured↔orthotope adapter는 `FieldValue`를 받아 같은 물리 metadata를 가진
새 field를 반환합니다. 수치 계산은 기존 overlap projection에 위임합니다.
orthotope는 축에 정렬된 segment/quad/hex만 지원하며 일반 tetrahedral mesh,
회전한 cell과 서로 다른 영역의 projection은 지원하지 않습니다. Named cell
block의 값 순서는 mapping의 block 순서입니다.

격자 간 projection에는 각 domain 단위의 `source_spacing`/`target_spacing`을
명시합니다. Solver가 보존한 domain metadata의 spacing을 전달해도 되지만,
좌표 vector만 보고 한 cell 축의 폭을 추정하지 않습니다. 동일한 structured
domain에서는 dtype을 바꾸거나 배열을 복사하지 않고 값을 공유합니다.

형상을 바꾼 결과는 새로운 domain identity와 원본을 가리키는 별도 provenance를
가집니다. 원본 scene/material snapshot을 변경하지 않으며 다음 Solver에는
기존 typed input port로 변형 domain/field를 전달합니다.

## Non-sequential ray tracing

`ray-tracing` Solver는 미리 정한 surface sequence 대신 다음 실제 충돌을
따릅니다. Source는 point, area, directional, Lambertian 형태로 구성할 수
있고, detector surface는 irradiance, detected radiant flux, source
efficiency 같은 일반 RecordedData를 만듭니다.

박막 처리는 실제 shell 두께에 적응합니다.

- 두께가 `50 µm`보다 작은 인접 shell은 하나의 coherent multilayer stack으로
  묶어 transfer-matrix method로 계산합니다.
- 두께가 정확히 `50 µm`이거나 그보다 크면 일반 geometry collision으로
  추적합니다.
- Reflection, transmission, scattering, absorption, detector hit, branching
  상태는 이 선택과 함께 물리적으로 이어져야 합니다.

기존 Ray version의 `state["rayPaths"]` Mapping은 유지합니다. 새 version은
동일한 path bundle을 typed artifact로도 내보낼 수 있습니다. Path bundle의
`vertices`, `pathOffsets`, `segmentPower`, `pathWavelength`, `segmentEvent`는
각각 vertex, variable-length path, segment와 path 축의 의미를 보존해야
합니다. Viewer 기록은 bundle을 한 번에 `sim.record()`하여 offsets로 path를
복원할 수 있게 합니다.

## 검증

Solver나 Runtime 경계를 변경할 때 최소한 다음을 확인합니다.

- 기존 DC, Heat, Ray와 verified Experiment bundle이 source 변경 없이 실행
- `sim.run()` state의 nested read, unchanged patch와 branch
- state/checkpoint 명시적 해제, busy-state 거부와 과거 handle 보관 시 buffer 수
- Electro-Thermal typed artifact handoff 및 domain projection 보존량
- 서로 다른 child 사이의 독립적인 mesh/field/particle/bundle 전달
- domain 보존 기록 schema의 inline/attachment encode/decode 왕복
- foreign/released handle과 artifact type mismatch 거부
- child crash, timeout, cancellation, 결과 검증 실패 시 commit/파일 잔존 없음
- 여러 artifact의 동일 Resource 공유와 독립 provenance/release
- RecordPacket ACK까지 resource lease 유지
- geometry cache hit/miss에서 동일한 numerical result
- 반복 호출 후 child PID, mmap, child workspace와 run cache 정리
- import-boundary 검사에서 resident Runtime의 Solver/Method eager import 차단

CAE directory에서 같은 pytest 진입점으로 단위·의존 방향·CPU 통합 검사를
실행합니다. CUDA 검사는 별도로 선택하고 실제 device가 없을 때의 skip을
성공적인 GPU 검증으로 보고하지 않습니다.

```powershell
poetry run python -m pytest tests -m "not cuda"
poetry run python -m pytest tests/test_fdtd_cuda.py -m cuda
```

반복 자원 검사에서는 revision metadata 수, ResourceStore node 수, mmap 파일
수를 따로 확인합니다. 호출 준비 비용과 전달 시간은 같은 입력으로 비교하며,
측정 없이 성능 개선을 주장하거나 기존 수치 허용오차를 넓히지 않습니다.

새 Solver에는 실제로 실행 가능한 Experiment 예제를 Catalog에 함께 둡니다.
예제는 literal Solver name/SemVer와 method IDs, Geometry/material 연결,
initialization/output, `sim.run`/`sim.record`/`sim.release`, 결과 QuantityKind,
unit과 axes 의미를 보여야 합니다. 예제 설명과 구체적인 Catalog 계약은
Catalog record가 소유하며 repository Markdown에 별도 원본으로 복제하지
않습니다.
