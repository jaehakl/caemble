# Caemble CAE slave

Caemble의 fully-built `BuiltMeasurement`만 받아 Python kernel을 실행하고, 선언된
RecordedData만 public v1 WebRTC result attachment로 반환한다. Caemble에 포함된 SDK와
application-level `cae.simulation.start` → `cae.simulation.next` protocol을 사용한다.

CAE에는 전체 QuantityKind나 Material catalog가 없다. 각
`app/solvers/<solver_name>/manifest.json`이 해당 solver가 실제로 사용하는 kernel identity,
reference geometry unit, material property, parameter, method,
input/output/observation spec과 Python implementation 경로를 소유한다. 일반 tensor codec은
UI가 보낸 `dtype`, `tensorOrder`, shape, ticks와 byte length를 검증한다. solver task,
geometry, material 값은 manifest 계약에 따라 CAE에서 UCUM 단위로 변환한다.

## Solver framework

- `app/kernels.py`는 기존 runtime 호출부를 보존하는 얇은 facade다.
- `app/solver_framework/registry.py`는 시작 시 모든 manifest를 schema 검증하고 identity,
  implementation 경로의 오류와 identity 중복을 확인한다.
- solver 구현 모듈은 manifest 검증 시 import하지 않으며 해당 kernel의 최초 실행 시
  import하고 cache한다.
- `app/solver_framework/world.py`는 target, surface, material, scalar parameter 해석을,
  `app/solver_framework/numerics/`는 voxel domain, scalar finite-volume system, PCG,
  axis tick과 dense field 변환을 제공한다.
- DC와 Heat 고유 계산은 각각 `app/solvers/dc_current_density/solver.py`와
  `app/solvers/steady_state_heat/solver.py`에만 둔다. 공통 physics base class는 사용하지 않는다.

새 solver는 중앙 registry나 validation 코드를 수정하지 않고 다음 순서로 추가한다.

1. `app/solvers/<solver_name>/manifest.json`, `solver.py`, 전용 테스트를 추가한다.
2. UI example을 추가하고 `npm run export:cae-fixture`로 실제 계약 fixture를 갱신한다.
3. focused fixture test와 전체 `poetry run pytest -q`를 실행한다.
4. 완료 전에 Caemble generated API check, Vitest, TypeScript, lint, build를 실행한다.

```powershell
cd app/slaves/cae
poetry install
poetry run python -c "import app, numpy, aiortc"
poetry run pytest
```

UI가 실제로 build/serialize한 raw `measurement`와 tensor attachment를
API나 launcher 없이 검증하려면 같은 Caemble checkout에서 fixture를 갱신한 뒤 focused
test를 실행한다.

```powershell
# Caemble 저장소 루트에서 실행한다.
Push-Location app/ui
npm run export:cae-fixture -- --example dc-uniform-bar --out ../slaves/cae/tests/fixtures/dc-uniform-bar
Pop-Location

Push-Location app/slaves/cae
poetry run pytest -q tests/test_fixture_e2e.py -k dc_uniform_bar
Pop-Location
```

fixture test는 실제 `cae.simulation.start`와 `cae.simulation.next` handler, tensor
attachment decoding, solver, record ACK와 terminal sequence를 실행한다. 이는 UI-CAE
계약 테스트이며 browser-launcher-CAE WebRTC E2E 통과를 의미하지 않는다. 새 kernel을
추가할 때는 먼저 작은 직접 kernel test를 작성하고, 해당 kernel을 사용하는 UI example과
fixture를 추가한다.

`poetry.toml`은 AI slave와 동일하게 project-local `.venv`를 사용한다. Windows에서는
`app\slaves\cae`에서 `poetry install`을 실행한다. Linux launcher 컴퓨터에서는 설치 후
다음 명령으로 실제 launcher가 사용할 환경을 검증한다.

```bash
cd /opt/caemble/app/slaves/cae
poetry install
test -x .venv/bin/python
poetry run python -c "import app, numpy, aiortc"
```

`poetry env info --path`가 이 폴더의 `.venv`가 아닌 기존 cache 환경을 가리키면
`poetry env remove --all`로 해당 프로젝트 환경을 제거한 후 `poetry install`을 다시
실행한다.

UI와 CAE는 함께 배포하지만 별도 contract package나 hash 비교를 사용하지 않는다.
이 디렉터리의 CAE manifest가 단일 계약 원본이다. Caemble UI는 같은 JSON을 Vite
build 시 직접 포함하며 사본이나 generated solver catalog를 커밋하지 않는다. 외부 SDK
호환을 위한 `cae.solvers.manifests` handler는 유지한다.

CAE registry는 solver `manifest.json`을 자동 검색한다. start payload는 정확히
`{ measurement: BuiltMeasurement }`이며 Simulation manifest v5와 Python simulation API v3만
받는다. 각 kernel world의 `experiment` scope는 공통 physical scene과 frozen materials를,
`task` scope는 현재 Task-local scene과 frozen materials를 제공한다.
첫 `next`가 계산을 시작하며 각 record는 다음
`next`의 `ackSequence`를 받아야 해제된다. 기본 실행 제한은 2시간, 첫 `next` 제한은 30초,
record ACK 제한은 120초다.

취소 시 CAE는 run의 pending tensor와 detached task를 정리한 뒤 launcher 내부용
`cae.run.cleaned` 확인을 보낸다. record 응답과 다음 `next` 사이처럼 cooperative cleanup을
확인할 수 없는 구간에서는 launcher가 2초 뒤 worker reset으로 승격하고, 기존 3초 종료 grace
이후에도 남은 프로세스는 재기동한다. 이 제어 메시지는 Caemble API로 전달하지 않는다.

`simulate.py`는 정확한 async ABI와 AST allowlist로 검증하며 import, 파일·네트워크 접근,
`eval` 및 임의 객체 호출을 허용하지 않는다. 이 정책은 신뢰된 Experiment source를 위한
가드레일이며 OS sandbox가 아니다. 운영 환경에서는 CAE worker 자체를 별도 OS 계정 또는
container 경계 안에서 실행해야 한다.
