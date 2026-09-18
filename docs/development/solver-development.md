# CAE Solver 개발 가이드

CAE Solver를 추가하거나 바꾸기 전에 이 문서와
`app/slaves/cae/AGENTS.md`를 모두 읽습니다. 사용자용 문법과 현재 예제는
Documentation에서 관리합니다.

## Experiment와 실행 계약

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

`state`는 계산 계보를 잇고, 실제 Solver 간 물리량 전달은 Catalog의 `exports`와
typed input port로 표현합니다. Task의 `config.exports`로 요청한 native artifact는
`sim.run()`의 `artifacts`에서 받아 연결하며 `sim.record()`에는 전달하지 않습니다.
`outputs`는 Calculation에 사용할 Box Grid 데이터이고, `visualizations`는 자동
포함되는 표시 자료입니다. Experiment bundle은 `sim.run`/`sim.record`/`sim.release`를 사용합니다.
Catalog는 Solver별 현재 버전과 새 예제만 제공합니다. 제거된 Solver 버전을
참조하는 Experiment는 오류로 종료하며 자동 변환하거나 다른 버전으로 재지정하지 않습니다.

`simulate.py`는 Python AST allowlist 아래에서 실행되고, 현재
BuiltMeasurement에 등록된 task만 `sim.run()`에 전달할 수 있습니다. 이
allowlist는 신뢰 가능한 Experiment program과 worker API 사이의 guardrail이지
OS sandbox가 아닙니다. Run/job ownership, progress, cancellation, record ACK와
cleanup lifecycle은 resident Runtime이 소유하며 Solver가 우회하지 않습니다.

## 3계층 구조와 의존 방향

CAE worker 코드는 다음 세 계층으로 나뉩니다.

```text
app/slaves/cae/app/
├─ __init__.py        package marker
├─ __main__.py        실행 진입점
├─ kernel/
│  ├─ api/             Solver ABI, StatePatch, 독립적인 DomainValue/FieldValue, 단위 계약
│  ├─ coordinator/     RunPlan/TaskSpec, SimulationApi, program, commit/rollback
│  ├─ execution/       spawn child, IPC, mmap serialization
│  ├─ resources/       state, artifact, buffer, cache
│  ├─ catalog/         descriptor snapshot과 locator 조회
│  └─ transport/       GPStation/local handler, 기록 schema 변환, record ACK lifecycle
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
   └─ <solver_package>/
      ├─ entry.py
      ├─ domain.py
      ├─ formulation.py
      └─ outputs.py
```

Solver의 공개 의존 방향은 `kernel.api <- methods <- solvers`입니다.
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

`app` 직속에는 package marker와 실행 진입점만 둡니다. 런타임 실행,
자원, 전송과 Catalog 처리는 `kernel`이 소유합니다. 옛 import 경로의
호환 facade나 별도 Solver framework를 두지 않습니다.

`RunPlan`은 Measurement 준비 시 normalized config, frozen descriptor, locator,
ABI, output 계약과 world snapshot을 `TaskSpec`으로 고정합니다. 각 호출은
등록된 task identity로 spec을 선택하며, 실행 때 Catalog나 다른 객체의 private
dictionary를 다시 조합하지 않습니다. `coordinator/commit.py`는 결과 검증,
state/artifact 등록과 mmap transaction 확정의 실패 복구를 한 경로로 수행합니다.

## 기본 원칙

- QuantityKind, Material Model 정의, Solver, Experiment Catalog 데이터의 단일 원본은
  `app/catalog/caemble_catalog/catalog.sqlite3`입니다.
- Experiment와 Solver의 SemVer는 공개된 동작을 식별합니다. 이미 publish된
  `(name, version)`의 계약과 locator를 고치지 않고 새 SemVer로 clone합니다.
  Catalog에는 Solver 이름마다 현재 버전 하나만 남깁니다. 이전 코드와
  Catalog release 이력은 Git으로 관리하고 worker에 구버전 구현을 남기지 않습니다.
- CAD, Geometry, Simulation, Catalog, built Measurement payload는 저장소 내부
  생산자가 만드는 데이터입니다. Material model 입력은 Catalog의 공통 Python
  schema validator로 필수 값, 중첩 객체, 반복 항, shape, 단위를 검증하고
  Task의 역할별 모델 선택을 다시 확인합니다. 별도 포맷 게이트, 중복 비즈니스
  규칙, geometry/resource 검증이나 입력 크기 제한은 추가하지 않습니다.
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

Catalog 저장 schema가 갱신된 checkout에서 이전 SQLite로 Draft를 만들었다면
`catalogctl --database $draft rebase`를 먼저 실행합니다. Schema 5는 Solver와
method parameter의 필수 여부를 보존합니다. `solver parameter upsert`와
`solver method-parameter upsert`의 기본은 `--required`이며, 생략 가능한 값은
`--no-required`로 선언합니다. 기본값의 물리적 의미와 적용은 Solver가 소유하고
Catalog 설명에 명시합니다. 기존 필수 parameter는 `required`를 생략한 공개
descriptor 모양을 유지하므로 rebase만으로 그 계약을 바꾸지 않습니다.

신규 Solver는 ABI 3 locator와 함께 생성합니다.

```powershell
poetry run catalogctl --database $draft solver create `
  "solver-name" "1.0.0" `
  --implementation "app.solvers.solver_package.entry:implementation" `
  --implementation-abi 3 `
  --description "Solver description"
```

공개 동작이나 계약을 변경하면 새 SemVer로 clone합니다. 구현 위치는 버전
디렉토리 없이 해당 Solver의 `entry.py` 한 곳으로 유지합니다.

```powershell
poetry run catalogctl --database $draft solver clone `
  "solver-name" "1.0.0" "1.1.0"

poetry run catalogctl --database $draft solver set-metadata `
  "solver-name" "1.1.0" `
  --implementation "app.solvers.solver_package.entry:implementation" `
  --implementation-abi 3
```

이어지는 `solver parameter`, `material-role`, `material-model-group`, `material-model-option`, `method`,
`method-parameter`, `input-port`, `observation`, `set-metadata` 명령도 모두
동일한 `--database $draft`를 사용합니다. Output method와 input port에는
canonical artifact type을 선언하고, producer와 consumer가 같은 물리 계약을
공유하게 합니다. 작업 중 descriptor와 artifact type projection은 CLI로
확인합니다.

```powershell
poetry run catalogctl --database $draft query solver "solver-name" "1.1.0"
poetry run catalogctl --database $draft query artifact-type
```

새 버전의 Example Experiment bundle을 `experiment upsert`로 등록하고
이전 예제는 `experiment remove`로 제거합니다. 모든 예제 참조를 이관한 뒤
이전 Solver 버전은 `solver remove`로 제거합니다. CLI는 예제가 참조 중인
Solver 제거를 거부합니다. 완성된 Draft를 명시적인 canonical destination으로 publish합니다.

```powershell
poetry run catalogctl --database $draft publish --destination $catalog
Pop-Location
```

Publish는 destination을 원자적으로 교체합니다. 배포 시 API, UI, resident
CAE worker가 같은 Catalog release를 사용해야 하므로 worker를 다시
시작합니다. API, UI와 worker를 함께 갱신해야 합니다. 저장된 사용자
Experiment의 Solver 버전은 자동으로 바꾸지 않으며 제거된 버전은 조회 오류가 됩니다.

## Solver descriptor

Catalog descriptor가 다음 경계를 소유합니다.

- Solver 이름, SemVer, 설명, implementation locator와 ABI version
- reference length unit과 일반 parameters
- initialization/output methods와 method parameters
- Geometry/material input ports와 typed artifact input ports
- Material 역할과 지원하는 모델 선택 그룹
- observations, output QuantityKind와 artifact contract
- 선택 가능한 설정을 위한 metadata

Experiment 예제에서는 Solver, method, QuantityKind, Material role 같은
Catalog 식별자를 문자열 literal로 적습니다. 수치 입력과 일반 설정은
계산식이어도 됩니다. Detector의 총 검출 파워처럼 복사 에너지인 출력에는
`optics.RadiantFlux`를 사용합니다.

ABI 3 implementation locator는 다음 형식을 사용합니다.

```text
app.solvers.<package>.entry:implementation
```

`entry.py`는 Catalog가 가리키는 유일한 공개 진입점입니다. Locator는 metadata
일 뿐 parent registry에서 import하지 않습니다. Solver별 조건문을
`kernel/coordinator/invocation.py`나 다른 중앙 모듈에 추가하지
않습니다.

## ABI 3 구현 경계

신규 Solver는 `SolverImplementation`을 export합니다.

```python
from app.kernel.api import SolverImplementation, SolverInvocation, SolverResult


async def run(invocation: SolverInvocation) -> SolverResult:
    # domain.py, formulation.py, outputs.py와 필요한 methods를 조합한다.
    ...


implementation = SolverImplementation(abi_version=3, run=run)
```

`SolverInvocation`은 호출마다 다음 값을 제공합니다.

- normalized task config와 task identity
- common/task scene 및 frozen Material snapshot을 포함하는 world
- immutable input으로 취급해야 하는 detached `Mapping` state
- Catalog input port 검증을 마친 `InputArtifact`
- child에서 바인딩한 canonical `GeometryService`
- progress callback과 cooperative cancellation token
- `cpu`의 가용 CPU·계산 예산과 child에서 연결하는 `execution` 서비스
- Solver descriptor
- run-scoped geometry cache 경로와 child-local workspace 같은 resource service

`SolverResult`는 수치 기록, 연성 값과 자동 표시 자료를 구분해 반환합니다.

```python
return SolverResult(
    state_patch=patch,
    artifacts={"outputName": output_value},
    exports={"exportName": native_value},
    visualizations={"visualizationName": visualization_value},
    observations={"iterationCount": iteration_count},
)
```

- `state_patch`: 이후 계산이 이어받을 재현 가능한 상태 변경
- `artifacts`: 요청된 수치 `outputs` method에 정확히 일치하는 결과
- `exports`: 요청된 native `exports` method에 정확히 일치하는 결과.
  Coordinator는 두 채널을 구분하여 검사한 뒤 `sim.run()`의 `artifacts`에 함께 반환
- `visualizations`: Catalog에 선언된 native mesh/ray 표시 자료. Output 요청 없이 자동 포함
- `observations`: Catalog에 선언된 작은 scalar/string/boolean 값

Solver는 파일 시스템, 네트워크, 프로세스 전역 mutable state나 이전 child의
메모리에 결과 정합성을 의존시키지 않습니다. GPU/device 객체는 child-local로
유지하고 공유할 결과만 host resource로 반환합니다.

ABI 3만 실행합니다. Solver는 `SolverInvocation`을 받고 `SolverResult`를
반환하며 `StatePatch`, `FieldValue`, `BundleValue` 같은 독립적인 값을 사용합니다.
이전 ABI adapter나 `SolverContext` 호환 실행 경로는 제공하지 않습니다.

## Preflight 임시 실행

Catalog와 Draft의 임시 실행은 기존 BuiltMeasurement·`simulate.py`·RecordedData
경계를 공유하며 현재 Candidate 설정을 그대로 실행합니다. 별도의 실행 모드나
Solver 설정 변환 hook은 제공하지 않습니다. 설정 탐색이나 자동 재실행도 하지 않습니다.
이전 약식 요청은 지원 종료 오류로 거부하며 현재 설정 실행으로 자동 전환하지 않습니다.

API는 `/cae/preflights`로 한 후보를 등록하고 기존 batch upload/commit/status/cancel
경로를 공유합니다. `/cae/preflights/{id}/result`는 고정된 결과 계약과 임시
Box Grid RecordedData와 별도 visualizations를 반환합니다. Experiment/Measurement 행을 만들지 않으며 완료 후
24시간에 조회가 만료됩니다. 기존 60초 정리 작업이 임시 DB payload와 Bucket
객체를 정리합니다. Outputs 전환에는 API migration `000000000012`와 같은 Catalog를
사용하는 API/UI/CAE 갱신이 필요합니다. 이 migration은 기존 RecordedData,
CalculationData, 임시 실행 결과와 파생 Record 계약을 초기화합니다. Source와
Measurement vars/material_snapshot은 보존하며 Calculation은 다시 preflight해야
합니다. 제거한 결과의 Bucket object에는 삭제 tombstone을 남깁니다. 실행 중인
CAE job을 먼저 종료해야 하며, 기존 Measurement가 있는 Source 잠금은 유지합니다.

## Material Model 입력

`material.tsx`는 Material별 모델 인스턴스와 모든 계수를 직접 구성합니다.
Material 이름은 이 Experiment 내부 식별자이며 외부 물성 조회나 sampling에
사용하지 않습니다. Catalog는 `model@version` 정의와 재귀 parameter schema를,
Solver는 역할별 `modelGroups`와 수치 구현을 소유합니다. 그룹 사이는 AND,
그룹 안에서는 정확히 하나를 선택하며 모호하면 Task의 명시적 선택이 필요합니다.

BuiltMeasurement의 `materialSnapshot`, `taskMaterialSnapshots`,
`modelDefinitions`, `materialSelections`를 RunPlan에서 고정합니다.
`world.materials[source][materialName].models[instanceName]`과
`world.materialSelections[role][materialName][group]`으로 선택된 입력을 읽습니다.
새 vars로 만드는 Candidate는 소스를 다시 평가하며 이전 계수를 덮어쓰지 않습니다.

FDTD Material은 비분산 epsilon 또는 Drude epsilonInfinity와 두 주파수만
소유합니다. main/buffer의 `drudeMethod`는 `none`, `RC`, `TRC` 수치법이며
인접 PML로 상속됩니다. Drude가 `none` region을 차지하면 오류입니다.
각 cell의 순간 유전율을 edge로 평균하고 susceptibility 기여를 같은 denominator에
합칩니다. 별도 fallback 유전율이나 Material별 RC/TRC 모델은 없습니다.
현재 RC/TRC 구현은 양의 plasma/damping 주파수만 지원합니다.

Ray는 complex index의 n과 k를 모두 명시적으로 받습니다. 독립적인 bulk
absorption 모델이 있으면 그 alpha를 쓰고, 없으면 `4*pi*k/lambda`를 사용합니다.
Frequency 표본은 Hz에서 선형 보간하고 범위 밖에서는 끝 값을 사용합니다.
산란 모델이 없으면 bulk 산란 기여가 없으며 `ray.hg-medium`의 적용 대상과
Task anisotropy 설정이 해당 산란 과정의 활성화를 소유합니다.

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
부모는 이를 내부 domain/field node와 `ResourceRef`로 변환합니다.
Solver의 내부·연성 domain field는 `FieldValue`, ray path와 복합 표시 자료는
`BundleValue`로 전달합니다. 수치 Output은 Box Grid Tensor로 변환합니다.
내부 ResourceRef를 Solver 입출력이나 method API에 노출하지 않습니다.

### 공통 물리량과 Particle 값

`QuantityArrayValue`는 domain 없는 물리 배열입니다. `quantity_kind`, `unit`,
`values`와 선택적인 `basis`, `components`, `metadata`를 가지며,
`FieldValue`는 기존 평탄한 인자를 유지하면서 같은 물리량 검증을 사용합니다.
Runtime은 이번 실행에서 고정한 Catalog QuantityKind로 UCUM 차원과 Tensor
차수를 확인합니다. 속성 이름이나 배열 모양으로 물리량을 추측하지 않습니다.
Scalar에는 basis나 components가 필요하지 않습니다. Tensor는 Cartesian
성분을 명시하거나 전체 Tensor 축을 보존합니다. Scalar QuantityKind에도 여러
Scalar 값을 담은 명시적인 `components` 축을 둘 수 있습니다. 기존 구조 Solver의
Pressure 6성분 응력이 이 표현을 사용하며, 이 저장 축이 QuantityKind의 물리적
Tensor 차수를 바꾸지는 않습니다. 이 규칙은 Field와 QuantityArray에 동일하게
적용하고 성분 이름의 유일성과 배열의 마지막 축 길이를 검증합니다. 대칭 2차 Tensor의 명시적인
6성분 표현과 Field의 `sampleAxes`도 보존하며 entity 축과 표본 축을 혼동하지
않습니다. 검증은 공개 결과와 state의 resource 경계에서 수행하며 내부 timestep의
임시 벡터까지 Quantity 객체로 감싸지 않습니다.

Catalog schema 7의 QuantityKind `tensorSymmetry`는 `general` 또는
`symmetric`을 명시합니다. 6성분 저장은 `symmetric`으로 선언된 2차 텐서만
허용합니다. 변형구배와 제1 Piola 응력은 전체 3×3 또는 9성분을 사용하며,
행은 현재 Cartesian 배치, 열은 기준 Cartesian 배치입니다. Scalar 물리량의
명시적인 성분 축 규칙은 그대로 유지합니다. 기존 Catalog를 새 저장 schema로
옮길 때도 별도 Draft의 rebase/publish를 사용합니다.

`ParticleSetValue`의 `positions`는 `[particle, 3]` world 좌표이고 `unit`은
길이 단위입니다. `coordinate_frame`은 `world`입니다. 각 `attributes` 값은
`QuantityArrayValue`이며 입자 수와 성분 차원이 일치해야 합니다. 별도 항목인
`particle_ids`는 중복 없는 음이 아닌 int32 또는 int64 배열이고 `material_indices`는
`materials` 대응표를 가리키는 정수 배열입니다. 대응표는 `source`, `task`,
`name`, frozen Material `definition`을 보존하므로 export를 다른 child에서
해석하기 위해 원래 Geometry를 다시 조회할 필요가 없습니다. ID와 재료 참조에는
QuantityKind를 붙이지 않습니다.

`particles.attribute_field(name)`은 같은 배열을 참조하는 읽기 전용 Field
표현을 제공합니다. 그 domain에는 좌표·ID·재료 대응을 유지하고 다른 속성은
포함하지 않습니다. Particle 속성 안에는 완전한 Field를 넣지 않으므로 순환
domain 참조가 생기지 않습니다. Resource와 mmap 경로는 동일한 backing
array를 공유하는 view도 보존합니다. 읽기 전용 Field 표현을 만들 때 원본 계산
배열의 writeable 설정은 바꾸지 않습니다.

이 Field는 `ParticleSetValue` domain과 `FieldLocation.PARTICLE`을 가진 독립적인
native export로 전달할 수 있습니다. 생산 결과의 commit과 소비자 typed input에
같은 QuantityKind·단위 계약 검사를 적용하며, basis·components·입자 수와
domain–location 대응은 기존 Resource 검증을 따릅니다. 생산 state를 해제해도
Field artifact의 lease가 남아 있으면 좌표·ID·재료와 값은 계속 유효합니다.

Particle Solver는 Geometry와 Material 및 생성 설정으로 입자를 생성하고,
배열 순서를 영구 identity로 사용하지 않습니다. 첫 입자 Solver들은 생성 후
입자 수가 고정됩니다. 호출 경계의 Particle 상태에는 다음 계산에 필요한
물리량과 solver별 접촉·재료 이력을 보존하고 이웃 탐색 가속 자료나 재생성
가능한 계산 격자는 child에 둡니다. 공유 물리량 계약이 같아도 다른 Solver의
continuation state를 직접 계승할 수 있다는 뜻은 아닙니다.

입자 native export는 Catalog의 `particleSet` 계약에 선언한 속성만 내보냅니다.
자동 particle visualization은 기존 typed Bundle과 visualization collection을
사용하며 위치·ID·재료·시간·선택 물리량을 보존합니다. DEM의 물리적 반경은
화면의 점 크기 설정과 별개입니다. 수치 Output은 기존 Box Grid를 사용합니다.
Cell 질량을 전체 cell 체적으로 나눈 밀도, 운동량을 전체 cell 체적으로 나눈
운동량 밀도, 운동량을 질량으로 나눈 속도를 기록하며 빈 cell은 0입니다.
출력 Box·해상도·표본 간격은 물리 계산의 격자와 시간적분을 결정하지 않습니다.

SPH 압력은 관측 시점의 입자 중심을 같은 Box cell에 귀속하고 현재 입자 체적
`m / rho`로 가중 평균합니다. 여기서 `rho`는 입자 자체의 재료 밀도이며 위의
전체 cell 체적당 질량밀도가 아닙니다. 빈 cell의 압력은 0이고 gauge pressure의
음수는 보존합니다. 같은 Box·gridShape·scope·시간 표본의 질량밀도를 함께 기록하면
`질량밀도 > 0`으로 유효한 압력 0과 빈 cell을 구분할 수 있습니다. 공간 배치와
가중 의미는 기존 Box Grid의 `configuration`과 `weighting`으로 전달합니다.

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
남습니다. `sim.record()`는 전송 계층의 영속 저장 ACK가 끝날 때까지 별도 lease를 잡은 뒤
해제하므로 Solver나 `simulate.py`가 array를 `resize(0)` 하거나 dict를
`clear()`해서 수명을 관리하지 않습니다. Released/foreign handle과 다른
Measurement run의 state는 거부됩니다.

## RecordedData 변환 경계

`transport/recording.py`는 live artifact를 선언된 기록 schema의 값 트리로
변환하고, `transport/tensor.py`는 inline tensor 또는 binary attachment를 만듭니다.
Experiment는 `{ task, output }` 참조만 선언합니다. 공통 빌드가 Catalog output의
Box Grid profile과 일곱 축을 고정된 결과 계약과 tensor schema로 만듭니다.
수동 dtype/group schema, native export와 visualization 기록은 거부됩니다.
`sim.record`는 live artifact의 Task·output·Solver 버전·artifactType 출처가
고정된 계약과 일치하는지 검사합니다.

수치 schema의 `boxGrid`는 version, sampling, components, channels, channelUnits,
선택적인 frequencyKind를 갖습니다. dtype은 float32 또는 float64이고 축 순서는
`[x, y, z, time, frequency, amplitudePhase, component]`입니다. 필요 없는 축도 길이
1로 남깁니다. 물리 Tensor 성분은 마지막 축에 평탄화하므로 tensorOrder에 따른
추가 축을 붙이지 않습니다. 실수는 value 한 채널, 복소수는 amplitude/phase 두
채널을 사용하며 위상의 단위는 rad입니다. 진폭 0의 저장 위상은 0입니다.
History output의 `scope: 'final'`은 현재 성공한 호출까지 수락된 마지막 표본 하나를
뜻하며 continuation 중에도 길이 1인 time 축을 반환합니다. 자동 history 시각화는
누적 이력을 유지합니다.

Target은 Experiment 또는 Task의 Box 하나로 resolve되어야 하고 gridShape는
필수입니다. 공간 좌표는 Box local `[0, size]` 안의 cell center이며 길이 1 축은
중심입니다. 회전·instance를 합성한 직교 Box transform을 보존하고 world bounding
box로 대체하지 않습니다. 해석 영역 안에서는 interpolation으로 구하며 Box 내부에
절점이나 요소가 없어도 유효합니다. 해석 영역 밖의 표본은 모든 채널을 0으로
기록합니다. aggregate method는 gridShape `[1, 1, 1]`을 사용하며 Box 전체에 걸친
물리량의 집계 의미를 method가 정의합니다. Heat의 maximum-temperature는 회전된
target Box와 전체 cell 체적이 교차하는 유한체적 cell의 최댓값이며, 교차 cell이
없으면 0입니다. DC의 total-current는 target Box로 잘린 native 단면 face를
적분합니다. 두 방식 모두 Box 내부에 cell 중심이 없어도 계산하며 전체 영역 또는
전체 단면을 포함할 때 원래 해석의 최댓값 또는 총전류를 보존합니다.

각 실제 tensor의 `boxGrid`에는 profile과 함께 origin, size, rotation, lengthUnit,
gridShape, source, rootId를 평탄하게 보존합니다. origin은 world 좌표의 local
최소 모서리이며 `world = origin + rotation * local`입니다. Candidate마다 달라지는
이 Geometry metadata를 Experiment의 정적 schema나 contract hash에 넣지 않습니다.
실제 tensor의 `provenance`에는 task, solver, stateRevision, invocation,
catalogRevision을 보존합니다. invocation은 값을 만든 호출의 순번이며 나중에
이전 artifact를 기록해도 최신 호출의 순번으로 바꾸지 않습니다. 서버는 frozen
Task·Solver·Catalog 계약과 출처가 일치하는지 확인합니다.
Forward는 Box Grid 전체를 추론한 뒤 Calculation을 실행하며, Candidate 간 대응은
정규화한 Box local 좌표를 사용합니다.

Catalog의 `visualizations`는 mesh-field, polyline 등의 표시 계약과 recording
projection을 별도로 선언합니다. 빌드는 Task별 `visualizationContracts`에
artifactType, schema, visualization을 고정합니다. 축 이름이나 Solver 이름으로
renderer를 추론하지 않습니다. 수치 artifact의 입출력 호환성 비교에서는 표시용
visualization/recording metadata를 제외합니다.

강체의 `mesh-transform` 표시도 기존 BundleValue를 사용합니다. Catalog는
기준 vertices/triangles, body별 offsets, body ID, local COM, 시간과 pose
member 경로 및 quaternion 순서를 선언합니다. Kernel은 이를 일반 tensor
bundle로 처리하고 Viewer가 강체 변환을 적용합니다. Cell-average 출력은
Box 내부 체적 quadrature로 계산하며, point sampling과 구분합니다.
Catalog 데이터 변경은 Draft SQLite와 catalogctl로 수행하며 계약의 breaking
변경은 Solver major 버전과 공식 예제를 함께 전환합니다.

자동 표시 자료는 Task별 마지막 성공 invocation의 snapshot을 유지합니다. 새
invocation의 commit에 성공한 뒤 이전 표시 resource를 해제하며 마지막 snapshot을
finalizing에서 전송합니다. 물리적 시간 이력은 snapshot 안에 보존하고 연성 trial마다
별도 결과를 쌓지 않습니다. mesh-field projection의 연결·Field·provenance leaf는
visualization collection에만 저장하며 ExperimentRecord를 만들지 않습니다.
`job.visualization`은 numerical Record와 하나의 전송 sequence를 공유하고 별도
ACK를 받습니다. 완료에는 recordSequences와 visualizationSequences가 각각
포함됩니다. 취소·실패 시 두 collection의 임시 결과와 resource를 함께 정리합니다.
Measurement 조회 `/measurement/{id}/visualizations`, preflight와 local export는
이 collection을 보존하지만 Calculation·analysis·prediction 입력에서는 제외합니다.

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
요청하고 grace period에도 종료하지 않으면 해당 호출의 계산 프로세스들을 terminate합니다.
CPU-bound Solver 실패나 취소 때문에 resident worker 전체가 종료되어서는 안
됩니다.

### CPU 예산과 batch 실행

`CAEMBLE_CAE_CPU_BUDGET`은 양의 정수 실행 설정입니다. 기본은 affinity를
반영한 가용 논리 CPU 수의 절반(내림, 최소 1)이고 명시값은 가용 수로
제한합니다. launcher와 로컬 CLI가 같은 정책을 사용합니다. 예산은 invocation에
고정하며 물리 config, Catalog와 `simulate.py`의 옵션에는 추가하지 않습니다.

`invocation.execution.map_batches(initializer, function, prepared, batches, workers)`는
모듈 locator 두 개와 준비 데이터, batch iterable을 받습니다. 초기화 함수는
준비 데이터를 받아 worker-local 값을 반환하고 계산 함수는 이 값, batch,
cancellation token을 받습니다. 결과는 제출 순서로 제공하며 다음 yield까지
유효한 borrowed 값입니다. 유지할 배열은 복사하거나 최종 누적 배열로 합칩니다.
준비 데이터는 worker마다 한 번 전달하며, 수행 중·미병합 작업은 합쳐 최대
worker 수의 두 배입니다. 중첩 pool은 지원하지 않습니다.

Resident executor는 Solver와 batch worker를 모두 직접 소유합니다. 계산용
pipe는 Solver와 worker를 직접 연결하고 resident는 Solver payload를 해석하지
않습니다. 준비 데이터와 batch별 mmap transaction을 분리하고 병합 후 batch
transaction을 해제합니다. 취소·오류 시 신규 제출을 중지하고 cooperative
cancel, terminate/kill, join을 거쳐 모든 독자를 종료한 다음 buffer와 workspace를
정리합니다. 기존 launcher의 전체 worker 종료 경로도 유지합니다.

Native thread 제어는 실행 서비스가 소유합니다. batch worker는 1스레드이며
`configure_torch()`는 새 Solver child에서 intra-op을 예산으로, inter-op을
최초 한 번 1로 설정합니다. Runtime은 Torch를 공통으로 eager import하지 않습니다.
Ray는 128개 초기 광선 단위로 같은 추적 함수를 직렬·병렬 실행하고, 512개 미만은
pool을 생략합니다. 실행 seed와 큐 깊이·초기 순번·재삽입 이력·종료 순번을
고정된 JSON으로 직렬화하고 별도의 BLAKE2b 해시로 완료 경로를 표본 추출합니다.
각 배치와 최종 병합은 같은 우선순위의 상위 `maxPaths`개를 제한 크기 heap에
보관합니다. 종료 순서·배치 분할·worker 수가 표본을 바꾸지 않으며, 경로 한도는
수치 누적을 중단하지 않습니다. `maxPaths=0`은 해시 계산과 경로 보관을 생략합니다.

기본 검사 실행기는 CPU 예산을 1로 고정합니다. 별도 병렬 검사는 executor에
명시적 예산을 전달하고 실제 CPU 수가 부족하면 그 비교를 skip으로 기록합니다.

별도 성능 측정은 CAE에서 `python -m tests.cpu_benchmark --report <새 경로>`로
실행합니다. 가용 범위의 1/2/4/8 예산마다 새 Ray·CPU FDTD 실행을 수행하며
단계별 시간, 전체 시간, 25 ms 간격의 전체 프로세스 RSS 합 최대 표본값과
잔류 child를 기록합니다. 일반 회귀 검사에 포함하지 않으며 작은 FDTD의 결과는
실제 큰 격자의 확장 성능을 대표하지 않습니다.

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
`task` scope로 전달됩니다. Solver는 child에 주입된 Geometry service에서
필요한 표현을 요청합니다. Ray tracing은 `continuous_solid`를 사용하고
mesh 기반 Solver는 root의 triangular mesh를 사용합니다.

두 scene은 별도로 평가·빌드·렌더링됩니다. 서로 겹친다는 이유로 CSG나 mesh를
변경하지 않습니다. Task의 source/domain/PML 같은 물리적 역할과 Experiment
재료 형상과의 상호작용은 해당 Solver가 명시적으로 정의합니다.

Surface group selector의 `rootId`, `sourceNodeId`, 숫자 `surfaceIndex`는
canonical provenance입니다. `surfaceIndex`는 primitive가 정한 숫자
slot입니다. Triangle 순서로 표면을 재식별하거나 Solver별 triangulation
경로를 만들지 않습니다. Transform과 Boolean을 거친 뒤에도 provenance로
emitter, detector와 boundary를 찾습니다.

길이는 descriptor의 reference unit으로 Solver-local 변환합니다. Model Parameter도 QuantityKind 차원에 따라 단위를 정규화합니다. 이 변환은
저장된 Geometry와 frozen Material snapshot을 수정하지 않습니다.

모델 파라미터의 값 읽기·단위 변환과 3×3 tensor의 `trace / 3` scalar 환산은 별도
책임입니다. 환산은 이를 사용하는 numerical method에서 명시적으로 수행하며
기존 수치 가정을 일반적인 Runtime 모델 조회 속에 숨기지 않습니다.

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

연속 형상 평가는 `methods.geometry`, 광선 교차와 최종 Boolean 사건 판정은
`methods.rays`, 광학 경계조건과 매질 전이는 `solvers.ray_tracing`이 소유합니다.
`SurfaceRef`는 root/source-node/surface-slot이며 occurrence는 canonical 배치
경로입니다. 내부 계산 patch나 표시용 tessellation은 표면 identity를 바꾸지 않습니다.
교차는 모든 사건을 제공하고 `hit/miss/unresolved`를 구분합니다. 판정 불능을
miss나 mesh fallback으로 숨기지 않습니다. 위치 오차 범위와 이전 사건 identity로
재출발 시 자기 충돌만 제외하며 전체 장면 크기의 epsilon을 사용하지 않습니다.
기본 연산은 float64입니다. 접선 근처에서 상쇄로 부호가 불분명해지는 작은
구간은 별도 mpmath context의 80자리 연산으로 확인합니다. 전역 정밀도 설정을
바꾸지 않으며, 여전히 해결하지 못한 후보는 `unresolved`로 남깁니다.

연속 Geometry 캐시는 geometryHash/root/reference unit을 사용하고 meshHash와
분할 설정을 읽지 않습니다. Bounds·표면 면적은 연속식의 구간 경계로 계산합니다.
표면 광원은 변환된 미분의 면적 요소로 rejection sampling하며 난수 counter에
표본별 재시도 번호를 포함합니다. 공간 탐색 bounds와 점광원용 최종 형상 극값은
별개입니다. 극값 계산은 국소 형상 크기의 1e-9와 부동소수점 오차 범위까지
정련하며 판정 불능은 오류입니다. 수치 반복 중 cancellation은 기존 child 종료
계약을 따르고 교차 임시 자료를 Solver state에 저장하지 않습니다.

`ray-tracing` Solver는 미리 정한 surface sequence 대신 다음 실제 충돌을
따릅니다. Source는 point, area, directional, Lambertian 형태로 구성할 수
있습니다. 수치 Output은 ray power의 체적 경로 적분으로 구한 Box Grid
fluence rate와 방향별 radiant flux density입니다. 검출기 표면의 흡수·종료는
명시적인 경계조건이며 Output 요청 여부와 무관합니다.

`ray-tracing 5.0.0`의 박막은 표면 경계조건으로 명시합니다.

- `ray.thin-film-stack`의 대상 Material에서 `optics.thin-film-stack@1` 모델을 선택합니다.
- 층 순서는 외부에서 내부이며 내부 입사 시 역순입니다. 실제 medium stack의 양쪽 매질을 사용합니다.
- 각 층은 `0 < thickness < 50 µm`여야 하며 기존 TMM을 재사용합니다. 더 두꺼운 층은 별도 solid로 작성합니다.
- film mesh나 출구 위치 이동을 만들지 않고 Geometry scale로 박막 두께를 변경하지 않습니다.
- 동일 표면의 중복 적층과 detector·grating 충돌을 거부합니다. 반사 후 표면 산란은 유지합니다.
- Reflection, transmission, scattering, absorption, detector hit, branching
  상태는 이 선택과 함께 물리적으로 이어져야 합니다.

Ray는 path bundle을 `BundleValue`로 자동 visualization에 포함합니다. `ray.paths`
Output이나 `recordedData` 선언은 필요하지 않습니다. Path bundle의
`vertices`, `pathOffsets`, `segmentPower`, `pathWavelength`, `segmentEvent`는
각각 vertex, variable-length path, segment와 path 축의 의미를 보존해야
합니다. Coordinator가 bundle을 한 번에 저장하며 Viewer는 offsets로 path를
복원합니다. 경로 보존량은 Solver의 기존 maxPaths 설정을 따릅니다.

## 검증

### 공통 CLI 빌드와 로컬 실행

Solver 개발에서는 모노레포의 Node CLI와 기존 CAE Python 환경을 함께 사용합니다.
UI의 npm 의존성과 CLI를 먼저 빌드하고, CAE의 Poetry 환경을 설치합니다.
`app/slaves/cae`에서 `poetry install --with dev`로 pytest, Ruff, Pyright 등 개발 검사 도구를
포함한 개발 환경을 구성합니다. `doctor`는 Python 실행 환경, pytest와 필수 수치·전송
패키지의 버전 및 모듈 위치를 출력하고 누락된 의존성을 표시합니다.
CLI는 `--repo`로 지정한 checkout의 CAE 작업 디렉토리에서 Python을 실행합니다.
`doctor`가 출력하는 Python, CAE/SDK/Catalog 모듈 경로와 Catalog revision이
개발 중인 checkout을 가리키는지 확인합니다. CLI 배포 파일만으로 Python
Solver 구현이나 수치 라이브러리를 제공하지는 않습니다.

```powershell
# 저장소 루트에서 실행합니다.
npm --prefix app/ui run build:cli
node app/ui/dist-cli/caemble.cjs --repo . doctor
node app/ui/dist-cli/caemble.cjs --repo . catalog show examples
node app/ui/dist-cli/caemble.cjs --repo . experiment build `
  --example <catalog-example-key-or-coordinate> --vars-mode nominal --out .local/build
node app/ui/dist-cli/caemble.cjs --repo . experiment test .local/build --out .local/result
```

빌드 산출물에는 canonical scene, frozen Material, 변수와 `simulate.py`를
포함한 BuiltMeasurement가 들어갑니다. 로컬 검사에는 CAE의 기존
`validate_and_load_simulate`를 호출하며 AST 규칙을 Node에서 다시 구현하지
않습니다. 로컬 실행은 `kernel/transport/local.py`를 통해 기존 `CaeRun`을
사용합니다. 각 기록은 기존 schema와 inline/binary 형식 그대로 파일에 저장한
후 ACK하며, 성공·실패·취소 상태와 trace는 결과 `manifest.json`에 남습니다.
Ctrl+C는 현재 로컬 실행의 cooperative cancellation과 child/resource 정리를
요청합니다. 결과 디렉토리는 실행마다 비어 있어야 합니다.

같은 빌드 산출물은 `batch submit`으로 원격 실행에 제출할 수 있습니다.
로컬 foreground 프로세스 종료와 서버에 저장된 batch의 수명은 별개입니다.
원격 watch 종료는 batch 취소가 아니며 원격 취소 명령을 명시적으로 사용합니다.

Draft Catalog는 조회와 빌드에 사용할 수 있지만, 실제 로컬 실행은 worker가
읽는 canonical Catalog revision과 빌드 revision이 같아야 합니다. Draft를
canonical에 명시적으로 publish한 후 새 Python 프로세스로 실행합니다. 다른
revision이나 제거된 Solver identity로 자동 재지정하지 않습니다.

`test_catalog_examples.py`와 `test_spectrometer_example.py`는 위의 공개
`experiment build`로 입력만 만듭니다. 이후 기존 Python harness가 실제
Solver child, 수치 결과와 ACK를 검증합니다. pytest에서 CLI의
`experiment test`나 다시 pytest를 호출하지 않습니다. 별도 esbuild 입력
빌더를 추가하지 않고 이 경로에 새 예제를 연결합니다.

### Runtime과 수치 검사

Solver나 Runtime 경계를 변경할 때 변경 영향과 아래 비용 분류에 맞춰 다음 항목을 확인합니다.
기본 검사는 정적 분석과 저비용 검사이며, 실제 연결·예제·정밀 검증은 명시적으로 선택합니다.

- 관련 Solver와 Catalog 예제가 새 계약으로 컴파일되며, 선택한 실행 범위에서 수치·연결 검증 통과
- 제거된 Solver 버전과 ABI 1/2 요청이 fallback 없이 오류로 종료
- `sim.run()` state의 nested read, unchanged patch와 branch
- state/checkpoint 명시적 해제, busy-state 거부와 과거 handle 보관 시 buffer 수
- Electro-Thermal typed artifact handoff 및 domain projection 보존량
- 서로 다른 child 사이의 독립적인 mesh/field/particle/bundle 전달
- Box Grid 일곱 축·회전·단일 표본·해석 영역 밖 0 및 inline/attachment 왕복
- native exports와 mesh/ray visualizations의 Calculation/recording 입력 거부
- Task별 최신 visualization 교체·별도 저장과 global sequence/ACK 검증
- foreign/released handle과 artifact type mismatch 거부
- child crash, timeout, cancellation, 결과 검증 실패 시 commit/파일 잔존 없음
- 여러 artifact의 동일 Resource 공유와 독립 provenance/release
- RecordPacket ACK까지 resource lease 유지
- geometry cache hit/miss에서 동일한 numerical result
- 반복 호출 후 child PID, mmap, child workspace와 run cache 정리
- import-boundary 검사에서 resident Runtime의 Solver/Method eager import 차단

### 변경 영향 검사와 명시적 Solver 실행

CAE 디렉터리의 기본 진입점은 `python -m tests.run affected`입니다. HEAD와
현재 staged·unstaged·untracked 파일을 비교합니다. `--base <ref>`로 비교
커밋을 바꾸고, `--list`로 실행 없이 선택 이유와 제외된 검사를 확인합니다.

| 명령                    | 실행 범위                                                                      |
| ----------------------- | ------------------------------------------------------------------------------ |
| `affected`              | 변경 관련 정적 분석과 작은 함수·계약 검사. 제품 Solver 실행 없음               |
| `quick`                 | CAE 전체 정적 분석과 저비용 검사. 제품 Solver 실행 없음                        |
| `affected --smoke`      | 관련 최소 연결·실제 child 검사 추가                                            |
| `affected --validation` | 관련 수렴·보존량 등 정밀 검사 추가                                             |
| `examples --key <key>`  | 지정 공식 예제의 새 nominal 입력 빌드·실행·ACK·정리와 180초 예산 측정          |
| `full`                  | 모든 CPU 검사·공식 예제·정밀 검증. 명시적 전체 검증 또는 release 검사에만 사용 |

`lowcost`, `smoke`, `validation`, `example`은 비용 분류이며, `cuda`는 별도
환경 표시입니다. `--smoke`와 `--validation`은 독립적으로 추가할 수 있습니다.
선택은 변경 영향과 허용 비용 분류의 교집합입니다. 정밀 테스트 파일을
수정해도 기본 검사에서 실행하지 않습니다. `--tests` 역시 비용 제한을
지키며, 지정한 등록 파일·node만 검사하고 무관한 UI·Catalog 작업을 실행하지
않습니다. 범위를 벗어난 명시 대상에는 필요한 옵션을 안내합니다.

선택 소유권은 `tests/selection.py`, 파일·함수의 비용 분류는 `tests/tiers.py`가
소유합니다. 새 소스·지원 fixture·테스트의 소유권을 함께 등록합니다. 미분류
대상과 오래된 분류는 선택 오류이며 전체 검사로 확대하지 않습니다. 허용되지
않는 테스트 파일은 pytest collection 전에 제외합니다. 공용 fixture는 지원
모듈에 두고 다른 `test_*.py`에서 가져오지 않습니다. 테스트 전용 계측은
제품 entry의 직접 호출과 실제 child 호출을 집계하며, 기본 검사 및 collection
중 제품 entry 진입은 계산 전에 실패합니다. 작은 테스트용 child는 허용합니다.

기본 Python 정적 검사는 Ruff `E9`, `F63`, `F7`, `F82`와 Pyright `basic`입니다.
Pyright 범위는 ABI 모델·서비스·상태·값과 11개 Solver entry에 명시합니다.
입출력 타입을 실제 계약에 맞게 보완하며 일괄 `Any`·`cast`·`ignore`로 넘기지
않습니다. 기존 AST 의존성 경계 검사도 저비용 경로에서 실행합니다.

UI 일반 변경은 UI `check:static`으로 연결합니다. `check`는 정적 검사와 unit
test를 모두 실행합니다. Catalog·공통 authoring 변경은 기존 builder와 Python
`validate_and_load_simulate`로 공식 예제를 검사하며 Solver를 실행하지 않습니다.
문서만 변경하면 문서 검사만 실행하고 CAE collection도 생략합니다. CAE 소유
범위 밖의 변경은 해당 애플리케이션의 검사 대상임을 별도로 표시합니다.

```powershell
poetry run python -m tests.run affected --list
poetry run python -m tests.run affected
poetry run python -m tests.run affected --base HEAD~1 --smoke
poetry run python -m tests.run affected --validation
poetry run python -m tests.run quick
poetry run python -m tests.run affected --tests tests/test_sph_outputs.py
poetry run python -m tests.run affected --smoke --tests tests/test_incompressible_handoff.py
poetry run python -m tests.run examples --key pulsed-microheater
poetry run python -m tests.run examples --key '*'
# 명시적으로 요청한 전체 CPU 검증에서만 실행합니다.
poetry run python -m tests.run full
# CUDA는 실제 장치가 있는 환경에서 별도로 검사합니다.
poetry run python -m pytest tests/test_fdtd_cuda.py -m cuda
```

`app/ui`에서는 `npm run test:catalog-examples -- --key <key>`로 지정 예제의
입력·프로그램 계약만 검사할 수 있습니다. `--key`를 반복해 여러 예제를 고르거나,
생략해 전체를 검사합니다. `--report <path>`는 입력 빌드 횟수와 Catalog revision을 기록합니다.

일반 pytest 실행은 기존 명시적 검사 경로이며 저비용 기본 선택을 적용하지
않습니다. 일상 검증에는 `tests.run`을 사용합니다. 이 실행기는 기본 4개 pytest
worker와 `worksteal` 분배를 사용하고 수치 라이브러리 스레드는 1개로 제한합니다.
`--jobs 1`은 직렬 실행입니다. 공식 예제 예산 측정은 항상 한 예제씩 직렬로
실행하며, 입력 빌드부터 기록·ACK·child·자원 정리까지 180초 이내여야 합니다.
예산 측정과 nominal pytest는 같은 실행 함수를 사용하므로 물리 결과·provenance·
native mesh와 버퍼·캐시·ResourceStore·child 정리도 한 번의 실행에서 검증합니다.
예산 제한은 개발용 측정 harness에만 적용하며 Solver ABI와 사용자 해석 timeout을
바꾸지 않습니다. 초과하면 실패와 실제 정리 시간을 보고하고 자동으로 생략하지
않습니다. 대표 `affected` 약 1분, 전체 저비용 `quick` 3분 이내를 목표로 합니다.

공식 예제 입력은 요청할 때만 공개 CLI로 빌드합니다. 같은 실행의 worker들은
Catalog revision·예제 버전·변수·CLI bundle hash가 같은 빌드를 파일 잠금으로
공유하고 테스트에는 독립 복사본을 줍니다. Solver 결과와 이전 실행의 테스트
통과 결과는 재사용하지 않습니다. 예제의 nominal 규모를 줄이더라도 고유 기능을
유지하고, 공간·시간 해상도를 바꾸면 추가 정련과 대표 출력 비교를 남깁니다.
기존 정밀 검증의 물리 조건·정련 단계·시간창·허용오차는 별도로 고정합니다.
CUDA 장치가 없어 skip한 검사는 GPU 검증 성공으로 보고하지 않습니다.

각 실행은 `.work/cae-tests/<run>`에 실행 옵션과 `summary.json`을 남깁니다.
pytest 경로는 선택 이유, 제외된 관련 검사, `events.jsonl`, `status.json`도
기록합니다. 요약에는 검사 수,
미완료 항목, setup·call·teardown 및 외부 정적 검사 시간, 제품 Solver 호출 수와
시간, 공유 입력 빌드 수, 실제 CLI 빌드 시도·성공·실패·미완료와 별도 authoring
빌드 횟수가 포함됩니다. 공유 입력과 실제 CLI 호출은 중복 합산하지 않습니다. 예제 경로는
`examples.json`, `environment.json`, `solver-events/`에 입력 빌드·실행과 기록·
정리 시간, 환경·코드·Catalog 식별자를 함께 기록합니다.
`--report`에는 새 빈 디렉터리를 지정합니다. 파일 분리와 parametrization 변경은
검사 수 감축으로 계산하지 않습니다.

수정 중에는 필요한 focused 검사와 선택한 smoke·정밀 비교를 실행합니다.
통합 후 `quick`을 사용하고 `full`은 명시적 요청이 있을 때만 실행합니다.
반복 자원 검사에서는 revision metadata, ResourceStore node, mmap 파일 수를
각각 확인합니다. 측정 없이 성능 개선을 주장하거나 수치 허용오차를 넓히지
않습니다.

새 Solver에는 실제로 실행 가능한 Experiment 예제를 Catalog에 함께 둡니다.
예제는 literal Solver name/SemVer와 method IDs, Geometry/material 연결,
initialization/output, `sim.run`/`sim.record`/`sim.release`, 결과 QuantityKind,
unit과 axes 의미를 보여야 합니다. 예제 설명과 구체적인 Catalog 계약은
Catalog record가 소유하며 repository Markdown에 별도 원본으로 복제하지
않습니다.

## MaterialInteraction 계약

Catalog Model의 `subject`는 단일 재료 또는 재료 쌍을 구분합니다. 기존 subject 없는 저장 정의는 단일 재료로 해석합니다. 새 Catalog schema 6은 이를 SQLite에 저장하며 Solver의 `interactions` 역할도 Catalog에서 읽습니다. Draft의 `solver interaction-role upsert/remove`로 대상과 모델 그룹을 편집합니다.

MaterialInteraction은 순서 없는 재료 쌍마다 하나이고 그 안에 여러 모델을 둘 수 있습니다. 저작 평가기는 `material.tsx`의 named export를 자동 수집하여 실제 사용한 재료 쌍만 동결합니다. BuiltMeasurement의 `interactions`와 Task별 `interactionSelections`가 전송 계약이며, 기존 MaterialSnapshot의 `materials` 모양은 유지합니다. Worker는 정의·계수·중복·호환성과 동결한 선택을 검증합니다. 이전 입력에서 새 필드가 없으면 빈 관계로 해석하며 제거된 Solver 버전은 재지정하지 않습니다.

Solver는 `world.interactions`, `world.interactionSelections`와 `world.interactionSubjects`를 받습니다. `kernel.api.world.interaction_model`로 두 part의 역할/그룹 모델을 읽습니다. 대칭 모델은 양쪽 순서로 조회할 수 있고 ordered 모델을 뒤집어 조회하면 오류입니다. 필수 그룹에 모델이 없거나 여러 후보가 있는데 Task의 `config.interactionModels` 선택이 없으면 실행 전에 거부합니다. 선택 그룹은 Catalog에 명시한 기본 동작을 Solver가 구현해야 합니다.

Particle 경로는 `material_model_by_name`과 `interaction_model_by_name`으로
같은 frozen 선택을 조회합니다. Material 조회에는 이름과 scene source를
전달하며 입자마다 임시 Geometry를 만들지 않습니다. Interaction의 선택 그룹에
Catalog `defaultModel`이 선언되어 있으면 Runtime이 모델 정의와 정규화한 계수를
확인하고 `world.interactionDefaults`에 고정합니다. 명시적으로 선택한 모델이
없을 때만 기본 모델을 사용하며 잘못된 선택을 기본값으로 대체하지 않습니다.
DEM은 실제 입자–입자와 입자–벽 접촉에 필요한 재료 쌍만 수치 계수로
준비합니다. 계산하지 않는 벽–벽 관계에 모델 입력을 요구하지 않습니다.

Rigid의 접촉 경로는 실제 solid의 삼각형 표면, BVH 거리, 회전 속도 한계와 접촉 impulse를 사용합니다. 초기 관통은 오류이며, 접촉 시간 단계는 수렴·관통 검사를 통과해야 승인합니다. 기본 마찰과 반발은 0입니다. 물리 계수는 Interaction 모델, 허용오차·반복 횟수·시간 설정은 Task initialization에 둡니다. 접촉점의 impulse 이력과 누적 마찰 소산은 state에 보관하고, BVH 같은 프로세스 로컬 객체는 state에 저장하지 않습니다. 관통 관측치는 solid 교집합의 두께 추정과 접촉점 간격에 기반합니다.

## 공유 초탄성과 Total Lagrangian solid

`methods.continuum.hyperelastic`은 Catalog와 실행 상태를 모르는 순수 수치 함수입니다.
같은 compressible Neo-Hookean 에너지에서 W, P, Cauchy 응력과 선택적인 dP/dF를
계산합니다. FEM은 기준 tet4 형상함수 미분과 체적을 준비하고 매 Newton 반복의
F에서 내부력과 일관 접선을 조립합니다. MPM은 접선 배열을 요청하지 않습니다.
작은 변형률 J2와 공회전 요소는 기존 Solver 경로에 남습니다.

Surface 지정 변위는 선택한 world 병진 성분에만 적용하며, 기준 외력과 함께
내부 하중계수로 증가합니다. 이 계수는 물리 시간이 아닙니다. 후보의 J가 양수가
아니면 line search 또는 증분 축소로 복구합니다. 최초 모델 오류와 지원하지 않는
재료/해석 조합을 재시도로 숨기지 않으며 승인 상태는 수렴한 증분에서만 갱신합니다.

MPM의 기준 위치는 ID에 대응하는 immutable 모델 데이터입니다. 현재 변형의
음향 tensor 최대 파속으로 timestep을 제한하며, 유효하지 않은 후보는 같은 승인
상태에서 최대 12회 timestep을 절반으로 줄여 다시 평가합니다. 양의 J와 유한한
응답뿐 아니라 강한 타원성도 승인 전에 검사합니다. 고정 격자 이탈은 즉시
거부하며, 재시도로도 유효한 재료 상태를 찾지 못하면 오류를 반환합니다. 관측 F는 극분해의 회전 보간과
log-stretch 보간으로 구성하고 응력, 밀도, J, 에너지를 다시 계산합니다.

Box Grid `configuration`은 기준 또는 현재 배치의 관측 위치를 뜻합니다.
응력 성분은 두 경우 모두 world Cauchy 응력입니다. MPM의 `weighting`이
`material-volume`이면 기준 관측은 V0, 현재 관측은 J V0로 가중 평균합니다.
빈 cell은 0입니다. 전체 에너지 aggregate는 모든 초기화 solid의 W V0 합이며
Box를 공간 필터로 사용하지 않습니다. 기존 질량밀도는 전체 cell 체적을 분모로
사용하므로 이 재료 체적 평균과 구분됩니다. 물리 mesh와 timestep은 관측 설정에
종속되지 않습니다. API, Calculation, Prediction과 Viewer는 이 metadata를 보존합니다.

## MINI 혼합 solid와 현재 면 압력

MINI 구성식은 독립적인 F와 q를 받으며 q를 고정한 dP/dF, dP/dq와 체적
잔차의 미분을 함께 반환합니다. 절점 변위·q와 요소 내부 bubble은 FEM이
소유하며, q를 기존 회전 슬롯이나 Material 계수로 저장하지 않습니다.
Bubble의 행렬과 잔차를 함께 축약하고 전역 보정 후 bubble을 복원합니다.
중력의 bubble 성분도 같은 적분으로 계산합니다. 힘·체적·bubble 잔차를
각각 무차원화하고 모두 수렴한 증분에서만 세 해 배열을 승인합니다.

MINI 출력은 FEM 내부 평가 경계에서 수렴한 F와 q로 응력을 구합니다.
현재 위치는 실제 bubble 변형 사상을 역으로 풀며, 역변환 실패를 빈 영역의
0으로 바꾸지 않습니다. Native 셀 값은 기준 체적 가중 평균입니다.
단면력은 기준 단면의 P N 적분, 모멘트는 실제 변형 위치의 팔로 계산합니다.

strainEnergy는 integral W(F) dV0를 유지합니다. equilibriumEnergy는
q의 질량행렬 M과 M q=lambda g 관계로 제거한 이산 에너지이며,
integral[mu/2 (F:F-3)-mu ln J] + q^T M q/(2 lambda)입니다.
두 에너지 차이와 반력의 가상일을 독립적으로 검사합니다. 평균압은
-trace(Cauchy stress)/3이며 내부 q나 외부 압력으로 대체하지 않습니다.

Follower pressure는 후보의 현재 삼각형 면적 벡터로 힘을 계산하고 그
미분을 외력 접선으로 조립합니다. MINI bubble은 경계에서 0이므로 이
표면 하중에 bubble 자유도를 추가하지 않습니다. 기존 기준 압력의 의미는
유지하며, 마지막 승인 변형에서 실제 하중과 반력을 복원합니다.
