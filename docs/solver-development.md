# CAE Solver 개발 가이드

CAE Solver를 추가하거나 바꾸기 전에 이 문서와
`app/slaves/cae/AGENTS.md`를 모두 읽습니다. 사용자용 문법과 현재 예제는
Workbench의 `/docs`에서 관리합니다.

## 기본 원칙

- QuantityKind, Material, Solver, Experiment 데이터의 단일 원본은
  `app/catalog/caemble_catalog/catalog.sqlite3`입니다.
- Experiment와 Solver의 SemVer는 공개된 동작을 식별합니다. 이미 publish된
  정체성은 고치지 않고 새 SemVer로 clone합니다.
- CAD, Geometry, Simulation, Material, Catalog, built Measurement payload는
  저장소 내부 생산자가 만든 신뢰 가능한 unversioned 데이터입니다. CAE
  worker에 별도 포맷 게이트, 중복 비즈니스 규칙, 입력 크기 제한을 만들지
  않습니다.
- Catalog 편집에는 raw SQL이나 별도 JSON/TS/Markdown 원본을 사용하지
  않습니다. 중앙 registry 분기나 Solver용 `manifest.json`도 만들지
  않습니다.
- Solver 고유 물리는 `app/slaves/cae/app/solvers/<solver_package>/`에 두고,
  공통 단위·Geometry·tensor·수치 기능만 solver framework에 둡니다.

## Draft SQLite와 publish

Catalog 작업은 `app/catalog`에서 canonical 파일의 Draft를 만든 뒤 같은
Draft 경로를 모든 명령에 명시하는 방식으로 진행합니다.

```powershell
Push-Location app/catalog
$draft = ".catalog-work/draft.sqlite3"

poetry run catalogctl --database $draft draft create
poetry run catalogctl --database $draft query solver
```

새 Solver라면 `create`, 기존 Solver의 변경이라면 `clone` 중 하나로
정체성을 준비합니다.

```powershell
poetry run catalogctl --database $draft solver create `
  "solver-name" "1.0.0" `
  --implementation "app.solvers.solver_package.solver:run" `
  --description "Solver description"

poetry run catalogctl --database $draft solver clone `
  "solver-name" "1.0.0" "1.1.0"
```

두 예시는 대안입니다. 이어지는 `solver parameter`, `material-role`,
`material-property`, `method`, `method-parameter`, `input-port`,
`observation`, `set-metadata` 하위 명령도 모두 동일한
`--database $draft`를 사용합니다. 작업 중 descriptor는 다음처럼 직접
읽습니다.

```powershell
poetry run catalogctl --database $draft query solver "solver-name" "1.1.0"
```

완성된 Draft는 그 파일을 source로 publish합니다.

```powershell
poetry run catalogctl --database $draft publish
Pop-Location
```

Publish는 canonical SQLite를 원자적으로 교체하며 이미 공개된 Solver
정체성은 그대로 보존합니다. API, UI, resident CAE worker는 같은 Catalog
release를 사용해야 하므로 배포 뒤 worker를 다시 시작합니다.

## Solver descriptor

Catalog descriptor가 다음 경계를 소유합니다.

- Solver 이름, SemVer, 설명, Python implementation locator
- reference length unit과 일반 parameters
- initialization methods와 method parameters
- Geometry/material input ports
- material roles와 필요한 Material properties
- observations와 output QuantityKind
- 선택 가능한 설정을 위한 metadata

Experiment 예제에서는 Solver, method, QuantityKind, Material role 같은
Catalog 식별자를 문자열 literal로 적습니다. 수치 입력과 일반 설정은
계산식이어도 됩니다. Detector의 총 검출 파워처럼 복사 에너지인 출력에는
`optics.RadiantFlux`를 사용합니다.

Implementation locator는 `app.solvers.<package>.solver:run` 형식입니다.
Registry는 Catalog snapshot을 읽고 실제 실행 시 해당 모듈을 lazy import
합니다. `kernels.py`에 Solver별 조건문을 추가하지 않습니다.

## Python 구현 경계

보통 한 Solver package는 다음 파일만 필요합니다.

```text
app/slaves/cae/app/solvers/<solver_package>/
  __init__.py
  solver.py
```

Entry point는 `async def run(context: SolverContext)`입니다. `context`에서
Solver-local world, common/task Geometry, frozen Material, unit conversion,
progress callback을 사용합니다. 파일 시스템, 네트워크, 프로세스 전역
mutable state에 계산을 의존시키지 않습니다.

`simulate.py`는 AST allowlist 아래에서 실행되며 다음 호출만 사용합니다.

```python
result = await sim.run("solver-name", "1.0.0", config)
await sim.record("detectedPower", result["outputs"]["detectedPower"])
await sim.release()
```

AST allowlist는 신뢰 가능한 Experiment 코드와 worker API 사이의
guardrail이며 OS sandbox가 아닙니다. 실제 격리는 전용 계정이나 container가
담당합니다. Run/job identity, record ACK, cancellation, release lifecycle은
runtime 소유이므로 Solver가 우회하지 않습니다.

## Geometry와 단위

Solver 입력은 authoring JSX나 preview mesh가 아니라 built Measurement의
canonical Geometry scene입니다. 공통 장면은 `experiment`, task별 장면은
`task` scope로 전달됩니다. Solver는 shared Geometry service에 root의
triangular mesh를 요청합니다.

Surface group은 다음과 같은 selector를 가집니다.

```json
{ "rootId": "optic", "sourceNodeId": "lens", "surfaceIndex": 1 }
```

`surfaceIndex`는 primitive가 정한 숫자 slot입니다. Triangle 순서로
표면을 재식별하거나 Solver별 triangulation 경로를 만들지 않습니다.
Transform과 Boolean을 거친 뒤에도 `sourceNodeId`와 숫자 slot을 통해
emitter, detector, optical boundary를 찾습니다.

길이는 descriptor의 reference unit으로 Solver-local 변환합니다. Material
property도 QuantityKind 차원에 따라 local unit으로 변환합니다. 이 변환은
저장된 Geometry와 frozen Material snapshot을 수정하지 않습니다.

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

3D Viewer에 path를 보낼 때는 semantic group `rayPaths`를 한 번에
기록합니다.

```python
await sim.record(
    "rayPaths",
    {
        "vertices": vertices,
        "pathOffsets": path_offsets,
        "segmentPower": segment_power,
        "pathWavelength": path_wavelength,
        "segmentEvent": segment_event,
    },
)
```

`vertices`는 `[V, 3]`, `pathOffsets`는 `[P + 1]`, `segmentPower`와
`segmentEvent`는 segment 수 `S`, `pathWavelength`는 path 수 `P`에
정렬합니다. Runtime은 이를 `rayPaths.<member>` RecordedData로 저장하고
Viewer가 offsets로 variable-length path를 복원합니다. 일반 Analysis는 이
system group을 표시하지 않습니다.

## Experiment 예제

새 Solver에는 실제로 실행 가능한 Experiment 예제를 Catalog에 함께
둡니다. 예제는 최소한 다음 관계를 명확히 보여야 합니다.

- literal Solver name/SemVer와 method IDs
- common/task Geometry group과 숫자 surface selector의 연결
- Material role과 frozen property의 연결
- initialization, output, `sim.run`, `sim.record`, `sim.release` 순서
- 결과 tensor의 QuantityKind, unit, axes 의미

광학 예제라면 source와 detector를 모두 포함하고, detector 일반 출력과
`rayPaths` Viewer 출력을 함께 보여 줍니다. 예제 설명은 Catalog record가
소유하며 repository Markdown에 중복 계약으로 복사하지 않습니다.
