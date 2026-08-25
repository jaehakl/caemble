# CAE Solver 개발 가이드

이 문서는 사람과 AI 코딩 에이전트가 Caemble 내장 Solver를 추가하거나 변경할 때 따라야
하는 필수 절차다. QuantityKind, Material, Solver 계약의 단일 원본은
`app/catalog/caemble_catalog/catalog.sqlite3`다. Solver별 JSON, UI용 TS 목록, generated
catalog 파일은 만들지 않는다.

아래의 모든 `catalogctl` 예시는 repository의 `app/catalog`을 현재 디렉터리로 두고
실행한다. 다른 위치에서 실행할 때는 global `--database`로 Draft 경로를 명시한다.

## 변경 전에 확인할 것

1. 이 문서와 `app/slaves/cae/AGENTS.md`를 끝까지 읽는다.
2. 비슷한 `app/slaves/cae/app/solvers/*/solver.py`와 그 전용 테스트를 읽는다.
3. canonical DB를 수정하지 않은 상태에서 현재 정의와 참조할 항목을 조회한다.

```powershell
Push-Location app/catalog
poetry install
poetry run catalogctl query solver dc-current-density 0.1.0
poetry run catalogctl query quantity-kind electromagnetism.Voltage
poetry run catalogctl query material-parameter electrical.conductivity
Pop-Location
```

반드시 기존 QuantityKind와 Material parameter를 재사용할 수 있는지 먼저 확인한다. 전체
후보를 소스 파일에서 검색하지 말고 `catalogctl query`를 사용한다. 새 QuantityKind나 Material
parameter 자체가 필요하다면 Solver 계약보다 먼저 별도의 catalog 변경으로 검토하고
publish한다. 이때도 같은 Draft DB와 CLI만 사용한다. 지원되는 명령과 필수 인자는 다음
`--help`에서 확인한다.

```powershell
poetry run catalogctl quantity-kind upsert --help
poetry run catalogctl quantity-kind unit --help
poetry run catalogctl material-parameter upsert --help
poetry run catalogctl material-model upsert --help
poetry run catalogctl global-qualifier --help
poetry run catalogctl design-rule --help
```

QuantityKind 삭제나 unit 변경은 Material 및 Solver 참조를 깨뜨릴 수 있고, Material parameter나
model 삭제도 Solver 또는 저장된 Experiment와 충돌할 수 있다. CLI가 허용하더라도
`catalogctl validate`와 semantic diff에서 모든 역참조 및 contract digest 변화를 확인한 뒤에만
publish한다. catalog release용 버전 문자열을 바꿀 때는 `catalogctl metadata --help`에 나온
키만 사용한다.

## Draft SQLite에서 계약 작성

모든 편집은 gitignored `app/catalog/.catalog-work/draft.sqlite3`에서 수행한다.
시스템 `sqlite3`, raw SQL, 임시 JSON/TOML manifest, Python으로 DB를 직접 수정하는 방식은
금지한다.

```powershell
Push-Location app/catalog
poetry run catalogctl draft create
poetry run catalogctl query meta
Pop-Location
```

새 Solver는 `solver create`로 identity와 구현 locator를 만든다.

```powershell
poetry run catalogctl solver create example-solver 0.1.0 `
  --implementation app.solvers.example_solver.solver:run `
  --description "What this solver computes." `
  --reference-length-unit m `
  --minimum-outputs 1
```

이미 공개된 Solver 계약을 변경할 때는 같은 version을 고치지 않는다. `solver clone`으로 새
version을 만든 뒤 편집한다. active-only 정책 때문에 clone은 이전 활성 version을 Draft에서
교체하며, 이전 version을 참조하는 Experiment는 새 배포 후 실행할 수 없다.

```powershell
poetry run catalogctl solver clone example-solver 0.1.0 0.2.0
```

계약 구성요소는 다음 구조화 명령의 `upsert`/`remove`로만 편집한다. 각 명령의 필수 flag는
현재 CLI의 `--help`를 먼저 확인한다.

```powershell
poetry run catalogctl solver set-metadata --help
poetry run catalogctl solver parameter --help
poetry run catalogctl solver material-role --help
poetry run catalogctl solver material-property --help
poetry run catalogctl solver method --help
poetry run catalogctl solver method-parameter --help
poetry run catalogctl solver input-port --help
poetry run catalogctl solver observation --help
```

data descriptor는 파일 경로가 아니라 해당 명령의 inline `--data-json` 인자로 전달한다.
`dtype`, `quantityKind`, `unit`, `tensorOrder`, axis, basis와 numeric constraint를 한 객체로
기술한다. input artifact type이 여러 개면 `--artifact-type`을 반복한다. CLI가 제공하지 않는
구성요소가 필요하면 raw SQL로 우회하지 말고 먼저 `catalogctl`에 검증 가능한 operation을
추가한다.

계약에는 최소한 다음을 빠짐없이 선언한다.

- Solver parameter와 각 method parameter의 data descriptor
- Material role, 대상 initialization method, 필요한 Material property
- initialization, boundary condition, output method와 occurrence/target cardinality
- output의 고유 `artifactType`과 data descriptor
- 입력이 있다면 허용할 producer artifact type과 data descriptor
- 작은 진행·수렴 정보만 담는 observation

QuantityKind는 DB에 존재하고 opaque가 아니어야 하며 선언 unit은 해당 QuantityKind의
`applicableUnits`에 포함되어야 한다. Material property도 DB의 canonical key를 참조해야 한다.
producer output과 consumer input은 artifact type뿐 아니라 dtype, QuantityKind, unit, axis,
tensor order가 호환되어야 한다.

## Canonical Geometry 입력

UI Viewer가 렌더링한 mesh는 CAE worker로 보내지 않는다. 각 Experiment 공통 scene과 Task-local
scene은 Canonical Geometry scene v1으로 전달된다. 이 계약에는 `geometryFormatVersion: 1`,
canonical SHA-256 `geometryHash`, `lengthUnit`, CSG root, geometry group, semantic surface group이
포함된다. primitive, transform, Boolean, shell, instance/fiber node를 exact-key와 resource limit로
검증한 뒤에만 Solver를 만든다.

한 Boolean node는 최대 128개 operand를 허용하고 재귀 triangle-pair work를 사전 계산한다.
Experiment 하나는 Task Geometry scene을 최대 128개 가질 수 있으며, common scene과 모든 Task scene의
고유한 `(geometryHash, rootId)`가 요구하는 triangle 합 및 run-scoped mesh cache도 2,000,000
triangle 예산을 공유한다. Solver는 이 예산을 우회하는 별도 mesh cache를 만들지 않는다.

Solver는 해석 도메인에 적합하면 canonical CSG를 직접 해석할 수 있다. triangular mesh가
필요하면 CAE 공용 geometry adapter를 사용하며 Solver 내부에 primitive/Boolean triangulation을
복제하지 않는다. 단위 변환은 Solver-local view에서만 수행하고 원본 canonical scene과 hash는
변경하지 않는다.

`surfaceGroup`의 source member는
`<geometry-id>/surface/<URL-encoded-face-key>` 형식이다. 예를 들어 명시적 leaf
`conductor.body`의 `+X` face는 `conductor.body/surface/%2BX`다. CAE에는
`{ rootId, sourceNodeId, faceKey }` selector로 전달되며 polygon ordinal을 다시 만들지 않는다.
CAD API v7-v9의 `/surface-N` source는 읽을 수 있지만 실행할 수 없고 semantic face로 자동
alias하지 않는다. 해당 Example은 원본 version을 유지하고 CAD API 10의 새 immutable
Experiment version으로 이행한다.

Experiment version을 추가할 때도 raw SQL을 사용하지 않는다. `experiment upsert --help`에서
지원 범위를 확인하고 `--cad-api-version 10`을 명시한 뒤 Draft의 validate와 semantic diff에서
기존 version 변경 없이 새 coordinate만 추가됐는지 확인한다.

```powershell
poetry run catalogctl experiment upsert example-experiment `
  --namespace caemble --repository verified --version 2.0.0 `
  --cad-api-version 10 --title "Example Experiment" --description "What this example verifies." `
  --bundle-file .catalog-work/example-bundle.json `
  --verification-file .catalog-work/example-verification.json
```

## Python 구현과 테스트

구현 locator가 `app.solvers.example_solver.solver:run`이면 다음 파일을 만든다.

```text
app/slaves/cae/app/solvers/example_solver/__init__.py
app/slaves/cae/app/solvers/example_solver/solver.py
app/slaves/cae/tests/solvers/test_example_solver.py
```

`run(context)`는 async callable이며 `SolverContext`가 제공한 정규화된 config, state, inputs,
world, progress와 catalog descriptor만 사용한다. 파일·네트워크 접근이나 전역 mutable run
상태를 추가하지 않는다. Solver 모듈은 registry 시작 시 import되지 않고 최초 실행 때 lazy
import되어야 한다. Solver를 등록하기 위한 registry 조건문이나 별도 manifest 파일은 만들지
않는다.

먼저 작은 직접 계산 테스트와 오류 경계 테스트를 작성한다. 그 다음 UI example을 추가하거나
갱신하고 실제 browser-side serializer로 fixture를 다시 export한다. fixture의
`solverContracts` digest를 손으로 계산하거나 복사하지 않는다.

```powershell
Push-Location app/ui
npm run export:cae-fixture -- --example <cad-api-10-experiment-coordinate> --out ../slaves/cae/tests/fixtures/<fixture-id>
Pop-Location

Push-Location app/slaves/cae
poetry install
poetry run pytest -q tests/solvers/test_example_solver.py
poetry run pytest -q tests/test_solver_registry.py tests/test_solver_validation.py
poetry run pytest -q tests/test_fixture_e2e.py -k <fixture-id>
Pop-Location
```

## 검증, publish, 완료 조건

구현과 Draft가 함께 준비된 뒤 다음 순서를 지킨다. `publish`만 canonical SQLite를 원자적으로
교체한다. validate나 test가 실패한 Draft는 publish하지 않는다.

```powershell
Push-Location app/catalog
poetry run catalogctl validate
poetry run catalogctl diff
poetry run catalogctl publish
poetry run catalogctl query solver example-solver 0.1.0
Pop-Location

Push-Location app/slaves/cae
poetry run pytest -q
Pop-Location
```

version을 올렸다면 마지막 query의 version도 새 값으로 바꾼다. 완료 전에 다음을 모두 확인한다.

- semantic diff에 의도한 Solver와 관계 변경만 있다.
- canonical DB에 Solver별 활성 version 하나만 남아 있다.
- `contractDigest`는 publish 과정에서 다시 계산됐고 API와 CAE에서 동일하다.
- `cae.simulation.start`는 누락·추가·불일치 digest를 계산 전에 `catalog_mismatch`로 거부한다.
- `cae.solvers.manifests`가 SQLite에서 재구성한 호환 wire를 반환한다.
- Solver JSON/TS catalog, SQLite WAL/SHM, Draft DB가 Git 변경 목록에 없다.
- `app/slaves/cae/manifest.json`은 launcher executable manifest이므로 그대로 남아 있다.

API, UI, CAE를 같은 catalog release로 배포하고 API 및 상주 CAE worker를 재시작해야 변경이
활성화된다.
