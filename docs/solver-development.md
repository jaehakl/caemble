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
│  ├─ api/             Solver ABI와 단위 계약
│  ├─ coordinator/     SimulationApi, program, 호출 transaction
│  ├─ execution/       spawn child, IPC, mmap serialization
│  ├─ resources/       state, artifact, buffer, cache
│  ├─ catalog/         descriptor snapshot과 locator 조회
│  └─ transport/       GPStation handler와 record lifecycle
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

의존 방향은 `runtime_kernel.api/resources <- methods <- solvers`입니다.

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

저장소 루트의 `runtime.py`, `kernels.py`, `program.py`, `handlers.py`와 기존
`solver_framework` import는 이전 구현을 위한 compatibility facade일 수
있습니다. 신규 코드는 `runtime_kernel`과 역할별 `methods` package를 직접
사용합니다.

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
- immutable input으로 취급해야 하는 `StateView` 또는 process-transport용
  detached `Mapping`
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

## Resource와 typed artifact

State와 Artifact의 실제 값은 resident coordinator가 소유하는 공통
`ResourceStore`에 저장됩니다. Resource tree는 scalar, mapping, sequence,
tensor뿐 아니라 structured grid, unstructured mesh, field, particle set,
ray set, structured bundle을 표현할 수 있습니다.

공간 field에는 적어도 domain reference, node/edge/face/cell/particle/ray
location, QuantityKind, unit, basis/components와 values가 있어야 합니다. 같은
field 값을 State와 여러 Artifact가 참조할 때 ResourceStore가 buffer를
공유하므로 Solver가 사본 공유를 위해 별도 object-identity 규칙을 만들지
않습니다.

`ArtifactHandle`은 다음 provenance를 갖는 run-scoped typed export입니다.

- unique artifact ID
- producer task, Solver name/version과 output name
- canonical artifact type
- produced state revision
- shared resource reference

Coordinator는 요청하지 않은 output, 누락된 output, 잘못된 artifact type과
관측값을 commit 전에 거부합니다. Consumer는 Catalog input port로 받은
`InputArtifact.value`를 사용합니다. 서로 다른 domain의 field를 shape만 보고
reshape하지 않고 `methods.coupling`의 명시적인 interpolation, L2 또는
conservative projection을 적용합니다. 같은 domain이면 backing resource를
복사하지 않고 사용할 수 있습니다.

`sim.release(handle)`는 artifact lease만 해제합니다. 같은 Resource를 state,
다른 artifact, 실행 transaction 또는 RecordPacket이 참조하면 실제 buffer는
남습니다. `sim.record()`는 브라우저 ACK가 끝날 때까지 별도 lease를 잡은 뒤
해제하므로 Solver나 `simulate.py`가 array를 `resize(0)` 하거나 dict를
`clear()`해서 수명을 관리하지 않습니다. Released/foreign handle과 다른
Measurement run의 state는 거부됩니다.

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

Structured field를 내보낼 때는 계산 domain identity를 함께 구성합니다.
예를 들어 DC의 Joule heating과 Heat의 source field는 동일 domain이면 값을
그대로 공유하고, domain이 다르면 conservative projection을 거칩니다.
새 Solver에서 shape가 같다는 이유만으로 서로 다른 grid/mesh의 field를
결합하지 않습니다.

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
- Electro-Thermal typed artifact handoff 및 domain projection 보존량
- foreign/released handle과 artifact type mismatch 거부
- child crash, timeout, cancellation, 결과 검증 실패 시 commit/파일 잔존 없음
- 여러 artifact의 동일 Resource 공유와 독립 provenance/release
- RecordPacket ACK까지 resource lease 유지
- geometry cache hit/miss에서 동일한 numerical result
- 반복 호출 후 child PID, mmap, child workspace와 run cache 정리
- import-boundary 검사에서 resident Runtime의 Solver/Method eager import 차단

새 Solver에는 실제로 실행 가능한 Experiment 예제를 Catalog에 함께 둡니다.
예제는 literal Solver name/SemVer와 method IDs, Geometry/material 연결,
initialization/output, `sim.run`/`sim.record`/`sim.release`, 결과 QuantityKind,
unit과 axes 의미를 보여야 합니다. 예제 설명과 구체적인 Catalog 계약은
Catalog record가 소유하며 repository Markdown에 별도 원본으로 복제하지
않습니다.
