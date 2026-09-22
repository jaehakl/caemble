# CLI로 Solver 개발하고 검증하기

Solver는 Experiment에서 지정한 물리 문제를 수치적으로 풀고 기록할 결과를 반환하는 해석 구현입니다. 이 안내는 기존 CAE 구조 안에서 Solver를 추가하거나 바꿀 때, 개발 환경 확인부터 Catalog Draft 작성·입력 빌드·수치 검증까지의 순서를 설명합니다. 이미 제공되는 Solver로 실험을 작성하려는 경우에는 [Experiment 작성 안내](experiment.md)부터 읽습니다.

## 시작 전에 읽을 문서와 준비할 환경

Solver를 변경하기 전에 `docs/development/solver-development.md`와 `app/slaves/cae/AGENTS.md`를 **끝까지 읽습니다.** 두 파일이 현재 개발 계약의 기준입니다. 이 안내는 작업 순서와 확인할 항목을 정리하며 별도의 ABI 정의나 Catalog를 만들지 않습니다.

명령 예시는 Caemble 저장소 루트의 **PowerShell 7**을 기준으로 합니다. UI의 Node.js 의존성과 CAE의 Poetry 개발 환경을 준비합니다. 먼저 `.\caemble.cmd doctor`로 Python·모듈 경로와 Catalog revision이 현재 저장소를 가리키는지 확인합니다. CLI가 없거나 오래된 경우 `npm --prefix app/ui run build:cli`로 빌드하고 다시 확인합니다. POSIX에서는 `sh ./caemble`을 사용합니다.

작업 전에는 기존 구현·수치법·테스트와 현재 Solver descriptor(설정, 입력·출력과 구현 위치를 담은 정의)를 함께 읽습니다. 풀려는 방정식, 단위, 영역, 경계조건, 기대 관측량과 수치 허용오차를 먼저 정하면 구현 후 무엇을 검증해야 하는지 명확해집니다.

## 개발 흐름과 구현 경계

1. **Catalog를 확인합니다.** 현재 데이터는 기존 Catalog Python 라이브러리 또는 `catalogctl`로 조회합니다.
2. **별도 Draft SQLite에서 계약을 작성합니다.** 모든 `catalogctl` 변경 명령에 Draft 경로를 명시합니다. Solver SemVer는 `catalogctl`로 생성하거나 복제하며 공개된 이름·버전의 계약은 바꾸지 않습니다. raw SQL, Node SQLite 어댑터, Solver용 `manifest.json`, 중앙 registry 분기나 Catalog 데이터 복사본을 만들지 않습니다. CAE·AI의 launcher manifest는 실행 파일 계약이므로 유지합니다.
3. **재료 모델의 지원 범위를 선언합니다.** Solver descriptor에 Material 역할별 지원 모델 그룹을 적습니다. 그룹 사이는 AND이며 각 그룹에서 호환 모델 인스턴스 하나를 선택합니다. 모델 정의가 파라미터 구조·단위·관례를, Solver 코드가 수치 구현을 담당합니다. Material 이름으로 계수를 조회하거나 모델 schema를 descriptor에 복제하지 않습니다.
4. **ABI 3 경계에 구현합니다.** `app/slaves/cae/app/solvers/<package>/entry.py`에 구현하고 Solver 고유의 영역·정식화·출력 코드를 주변에 둡니다. 기존 method에는 필요한 값을 명시적으로 전달합니다. 의존 방향은 `kernel.api <- methods <- solvers`를 유지합니다. 상주 coordinator는 Solver 코드를 미리 import하지 않으며 Catalog locator는 새로 생성한 자식 프로세스에서 읽습니다.
5. **결과 채널을 구분합니다.** `SolverResult`에 `state_patch`, 요청한 typed artifact, 자동 표시 자료와 선언한 관측값을 반환합니다. 아래 출력 계약 점검표를 확인합니다.
6. **실행 관리는 기존 경로에 맡깁니다.** `simulate.py`가 `sim.run`, `sim.record`, `sim.release`로 실행 순서를 구성합니다. Coordinator가 자동 표시 자료의 수명을 관리하며 Task별 마지막 성공 호출을 유지합니다. Task 소유권, 취소, 진행 상태, 자식 프로세스 수명과 수치 기록·표시 자료 양쪽의 ACK·자원 해제를 보존합니다. 기존 CAE Python 검증기와 테스트를 사용하며 두 번째 Python 문법이나 API에서만 동작하는 구문 검사 경로를 추가하지 않습니다.
7. **전체 예제를 함께 작성합니다.** Draft에 실행 가능한 Example Experiment를 추가하거나 갱신합니다. 현재 Solver 이름·버전과 method ID를 문자열 literal로 명시하고 형상·재료 연결, 출력, 기록 형식, 단위와 축을 포함합니다. CAE 빌드 어댑터를 통해 CLI·UI와 같은 Node 빌드 경로를 사용하고 필요할 때 Draft를 명시합니다. 예전 독립 prepare 구현을 별도 컴파일러로 유지하지 않습니다.
8. **Draft 검사 후 같은 Catalog로 실행합니다.** 먼저 Solver 실행 없이 Draft descriptor와 전체 예제의 빌드를 검사합니다. 로컬 실행은 canonical Catalog를 사용하므로 검증한 Draft를 `catalogctl`로 명시적으로 publish한 다음 canonical 기준으로 다시 빌드하고 새 Python 프로세스에서 실행합니다. CLI는 자동 publish나 식별 정보 재지정을 하지 않습니다. 이전 Catalog 버전을 제거하기 전에 모든 예제를 새 활성 Solver 버전에 맞춥니다.
9. **변경 범위에 맞게 검증합니다.** 같은 canonical revision에서 관련 수치 검사, CPU 연결 검사와 공식 예제를 확인합니다. 변경과 관련된 경계·오류 조건을 포함하고 통과를 위해 허용오차를 넓히지 않습니다. 자원·수명 경계를 바꿨다면 취소·비정상 종료의 rollback, 다른 실행이나 해제된 handle, artifact 계약과 mmap·자식 프로세스 정리를 검사합니다. CLI의 형상 출력과 Calculation으로 수치를 확인합니다. CUDA skip은 GPU 검사 성공과 구분하며 API·UI·CAE는 검증한 같은 Catalog release로 배포합니다. 기존 사용자 Experiment의 Solver 버전은 자동으로 바꾸지 않습니다.

### 출력 계약 점검표

- 수치 출력은 `x, y, z, time, frequency, amplitudePhase, component` 일곱 축의 실수 Box Grid tensor입니다.
- Experiment 또는 Task의 Box 하나를 선택하며 `gridShape`가 필요합니다. 선언한 point 보간 또는 cell 체적 적분을 적용하고 해석 영역 밖은 0으로 기록합니다. Box 변환과 채널·성분 메타데이터를 유지합니다.
- Native 연성 값은 `exports`, 비정형 표시 자료는 `visualizations`에 둡니다. 둘 다 Calculation 입력이나 `sim.record` 데이터가 아닙니다.
- 호출 입력 state는 변경하지 않는 값으로 취급하고 Runtime의 `ResourceRef`를 노출하지 않습니다. shape가 같아도 서로 다른 격자가 같은 물리 영역은 아니므로 기존에 지원하는 연성 method로 연결합니다.

개발 결과에는 구현·Catalog 변경, 사용한 예제, 실제 실행한 명령·검사, 수치 근거, 소스·Catalog 해시와 검사하지 못한 장치별 동작을 남깁니다. 사용자용 참조는 웹·CLI의 공유 문서에, 구조·운영 지침은 개발 문서에 관리합니다.

## 입자 값과 물리 배열 다루기

Particle의 각 물리 속성에는 `QuantityArrayValue`를 사용합니다. `FieldValue`와 같은 QuantityKind, UCUM 단위, basis·components와 배열 검증을 사용하며 Field 생성자는 기존 평탄한 인자를 유지합니다. 속성 이름으로 추측하지 말고 Catalog에서 QuantityKind와 artifact 정의를 읽습니다.

스칼라에는 성분 basis가 필요하지 않습니다. 스칼라 QuantityKind도 기존 구조 응력 Field처럼 이름을 가진 여러 스칼라 성분의 축을 명시할 수 있습니다. 이름은 유일하고 마지막 배열 차원의 길이와 일치해야 하며 이 저장 축이 물리 Tensor 차수를 바꾸지는 않습니다. 명시적인 압축 대칭 Tensor 성분과 Field 표본 축의 선언된 의미도 유지합니다.

입자는 canonical Geometry와 고정된 Material 입력으로 만듭니다. `ParticleSetValue`는 world 위치, 중복 없는 int32 또는 int64 `particle_ids`, `material_indices`와 외부 조회 없이 해석 가능한 고정 Material 표를 가집니다. 배열 순서를 바꿀 때 ID와 선언된 정수 dtype, Material 참조와 물리량의 대응을 함께 유지합니다. Solver 고유의 연속 실행 state는 다른 Solver에 전달할 물리 export와 구분합니다. `attribute_field(name)`은 해당 속성의 배열을 공유하며 내보낸 domain에서 관련 없는 속성을 제외합니다.

수치 시간 적분과 계산 격자는 Box Grid 관측 설정과 독립적으로 유지합니다. 호출 구간마다 재현 가능한 물리 상태를 저장하고 이웃 탐색 구조나 재생성 가능한 격자 작업 공간은 자식 프로세스에 둡니다. Native 계약에 선언한 Particle 속성을 export하고 입자 표시는 기존 자동 visualization Bundle로 반환합니다. 기록에는 선언한 수치 Box Grid 출력만 사용합니다. 연속·분할 실행 비교, 관측 설정만 바꾼 경우, 재료·ID 대응, 공유 mmap 저장소와 실패한 시도의 rollback을 검사합니다.

기존 Material·MaterialInteraction 선택 경로를 사용합니다. `material_model_by_name`과 `interaction_model_by_name`은 임시 Geometry 없이 입자의 Material 참조를 지원합니다. 선택 Interaction 그룹은 검증한 Catalog `defaultModel`을 선언할 수 있지만 명시한 선택이 잘못되거나 모호한 경우에는 오류로 처리합니다. 공통 body 대상에는 입자와 고정 벽이 포함됩니다. 선택 그룹은 재료 쌍별 설정을 유지하며 사용하지 않는 벽–벽 접촉까지 명시적 모델을 요구하지 않습니다.

## 1. 개발 문서를 읽고 Draft 만들기

두 필수 문서를 모두 읽습니다. `agent context`는 명시된 출력 예산 안에서 해당 checkout의 정확한 문서와 해시를 제공합니다. 관련 검사와 물리 허용오차는 변경하는 구현을 기준으로 선택합니다.

```powershell
Get-Content -LiteralPath docs/development/solver-development.md -Encoding UTF8
Get-Content -LiteralPath app/slaves/cae/AGENTS.md -Encoding UTF8
.\caemble.cmd doctor
.\caemble.cmd agent guide solver
.\caemble.cmd agent context solver
Push-Location app/catalog
$catalog = 'caemble_catalog/catalog.sqlite3'
$draft = '.catalog-work/solver-development.sqlite3'
poetry run catalogctl --database $draft draft create --source $catalog
poetry run catalogctl --database $draft query solver
Pop-Location
```

`solver create/clone`, 타입이 지정된 config·output·input과 Example 변경은 개발 문서의 절차에 따라 이 Draft에 적용하며 항상 `--database`를 지정합니다. Descriptor별 정확한 명령은 현재 Catalog CLI 도움말에서 확인합니다. 실제 Solver 식별자와 Catalog 항목은 조회한 값을 사용합니다. 저장소의 구현과 테스트를 수정한 뒤 새로 작성한 예제를 선택합니다.

## 2. Solver 실행 없이 예제 빌드하기

```powershell
$draftCatalog = (Resolve-Path app/catalog/.catalog-work/solver-development.sqlite3).Path
.\caemble.cmd catalog show examples --catalog $draftCatalog
$exampleKey = 'REPLACE_WITH_DRAFT_EXAMPLE_KEY'
.\caemble.cmd experiment build --example $exampleKey --catalog $draftCatalog --vars-mode nominal --out .work/draft-build
```

`REPLACE_WITH_DRAFT_EXAMPLE_KEY`를 실제 Draft 예제 키로 바꿉니다. Draft 빌드는 선언, 소스 규칙, 입력 구성과 `simulate.py`를 검사합니다. **수치 해석을 실행하는 검사는 아닙니다.** 진단 메시지와 고정된 입력을 확인합니다.

## 3. 검증한 Draft를 반영하고 로컬 실행하기

다음 publish는 실제 canonical Catalog를 변경합니다. 반영하려는 Draft의 검증을 마친 뒤 실행합니다. Publish 후에는 canonical 기준으로 다시 빌드해 활성 식별 정보를 확정합니다.

```powershell
Push-Location app/catalog
poetry run catalogctl --database $draft publish --destination $catalog
Pop-Location
.\caemble.cmd doctor
.\caemble.cmd experiment build --example $exampleKey --vars-mode nominal --out .work/solver-build
.\caemble.cmd experiment test .work/solver-build --out .work/solver-results --timeout 120
.\caemble.cmd data inspect --result .work/solver-results/1
```

다른 canonical revision에서 `.work/draft-build`를 그대로 실행하지 않습니다. 위의 `experiment test`는 독립적인 사용자 명령이며 원격 작업을 제출하지 않습니다. 결과 manifest와 기록을 소스·Catalog 해시와 함께 보관하고 [Calculation 작성 안내](calculation.md)에 따라 정량 검사와 재현 가능한 그림을 만듭니다.

## 4. 변경 범위에 맞는 검사 실행하기

부분 변경은 먼저 선택 이유를 확인하고 기본 검사를 실행합니다.

```powershell
Push-Location app/slaves/cae
poetry run python -m tests.run affected --list
poetry run python -m tests.run affected
Pop-Location
```

기본 `affected`와 `quick`은 정적·저비용 검사만 수행하며 제품 Solver를 호출하지 않습니다. 관련 연결 검사가 필요하면 `--smoke`, 수렴·보존량 등 정밀 검사가 필요하면 `--validation`을 각각 추가합니다. `--tests`로 파일을 지정해도 비용 제한을 넘지 않습니다. 수정 중에는 관련 검사에 집중하고 통합 후에는 `quick`으로 확인합니다.

공식 예제의 실제 실행을 확인하려면 CAE 디렉터리에서 `poetry run python -m tests.run examples --key <key>`를 사용합니다. 새 nominal 입력의 빌드부터 기록·ACK·자식 프로세스·자원 정리까지 180초 예산으로 측정합니다. `full`은 명시적으로 요청한 전체 검증이나 구현을 확정한 release 검사에만 사용합니다. CUDA 검사는 실제 장치가 있을 때 별도로 선택하며 skip을 성공으로 기록하지 않습니다.

CPU 연결 검사의 fixture도 같은 CLI `experiment build`로 입력을 만들고 Python 검사 코드가 Solver 자식 프로세스와 수치·자원 동작을 검증합니다. pytest fixture 안에서 `experiment test`를 호출하거나 pytest를 재귀 실행하지 않습니다.

## 완료 여부 확인하기

선택한 검사의 성공만으로 검사하지 않은 물리 조건이나 장치까지 검증했다고 판단하지 않습니다. 보고서에는 실제 검사 범위, 기대 수치와 오차, 입력·Catalog 식별 정보, 남은 검사를 함께 남깁니다. 실패를 수정한 뒤에는 변경 관련 검사부터 다시 실행합니다.

자주 막히는 경우는 Draft와 canonical revision의 불일치, 제거된 Solver 버전 참조, 요청한 출력과 반환 artifact의 불일치입니다. 먼저 `doctor`의 경로·revision과 빌드 입력을 비교하고 개발 문서의 해당 계약을 확인합니다. 버전이나 계약 오류를 자동 대체로 숨기지 않습니다.

## 다음으로 읽을 문서

- [Experiment 작성하기](experiment.md): 새 Solver를 사용하는 완전한 실험과 기록을 구성합니다.
- [Calculation 작성하기](calculation.md): 결과 수치와 그래프를 재현 가능하게 검증합니다.
- [실행과 자원 관리](../manual/program/program-runtime-rules.md): Task 실행, state와 자원 수명을 확인합니다.
