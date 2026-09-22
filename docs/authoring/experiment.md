# CLI로 Experiment 작성하고 실행하기

Experiment(실험 정의)는 형상, 재료, 해석 조건, 실행 순서와 기록할 결과를 소스 묶음으로 관리합니다. 이 안내에서는 실행 가능한 예제에서 시작해 소스를 검사하고, 작은 조건 하나를 로컬에서 실행한 뒤 결과를 확인합니다. 서버 저장과 원격 실행은 별도 단계에서 진행합니다.

화면에서 먼저 실험을 경험하고 싶다면 [첫 실험 따라 하기](../manual/workbench/workbench-quickstart.md)를 읽습니다. 코드 파일의 역할은 [프로그램 구성](../manual/program/program-overview.md)을 참고합니다.

## 시작 전에 준비할 것

Caemble 저장소에서 작업하며 루트의 `AGENTS.md`를 먼저 읽습니다. 아래 명령은 저장소 루트의 **PowerShell 7**, Node.js 24.14 이상과 이 저장소의 CAE Python 환경을 기준으로 합니다. 출력 디렉터리는 비어 있어야 하며 명령 하나가 성공한 것을 확인한 뒤 다음 단계로 넘어갑니다.

먼저 `.\caemble.cmd doctor`로 환경을 확인합니다. CLI가 없거나 오래된 경우 `npm --prefix app/ui run build:cli`를 실행하고 다시 확인합니다. POSIX에서는 `sh ./caemble`을 사용합니다. 정확한 옵션은 설치된 CLI의 도움말을 확인합니다.

서버 작업에는 `.env`의 `CAEMBLE_API_URL`과 `caemble` 범위의 `CAEMBLE_API_TOKEN`이 필요합니다. 외부 작성 에이전트의 모델 인증 정보는 에이전트가 관리합니다. 소스 묶음에는 `.env`, 토큰, 개인 키나 관련 없는 작업 파일을 넣지 않습니다.

## 작성할 때 확인할 순서

1. **수정할 원본을 확인합니다.** 저장소 revision, API 주소, 인증 사용자, Catalog revision, Experiment ID·좌표·버전과 소스 해시를 기록합니다. 기존 실험은 원본 식별 정보를 포함한 전체 소스 묶음을 내려받습니다. 다른 revision에서 파일 하나만 복사한 상태로 수정을 시작하지 않습니다.
2. **완성된 예제를 고릅니다.** Catalog의 Python 라이브러리나 `catalogctl`로 현재 Solver descriptor(지원 입력·출력과 설정을 설명하는 정의)와 전체 예제를 확인합니다. Solver 이름·버전, method ID, 재료 역할, 출력 이름과 QuantityKind는 여기서 가져옵니다. UI의 초기 소스는 초안이며, 자리만 마련한 Task와 아무 해석도 하지 않는 `simulate.py` 본문은 해석 성공을 보여 주지 않습니다.
3. **파일의 역할을 구분합니다.** `experiment.tsx`는 `experiment(...)`로 실험을 정의하고, `geometry.tsx`나 가져온 로컬 모듈은 이름을 가진 Geometry 컴포넌트를 제공합니다. `material.tsx`는 Material 인스턴스, 각 `tasks/*.tsx`는 default export한 `defineTask(...)`, `simulate.py`는 실행 순서를 담당합니다. 사용할 속성의 정확한 선언과 Element 참조를 읽습니다. TypeScript 검사 통과만으로 Caemble 소스 작성 규칙을 모두 만족하는 것은 아닙니다.
4. **형상·재료·출력을 연결합니다.** 아래의 입력 연결 점검표를 사용해 실제 Solver가 받는 설정과 기록할 결과를 확인합니다.
5. **단계별로 검사합니다.** 경로·import 연결·소스 규칙을 확인하고 공통 TypeScript 컴파일러와 로컬 빌드·평가를 사용합니다. `simulate.py`는 기존 CAE Python 환경의 프로그램 검증기로 검사합니다. Node의 TypeScript 검사는 Python을 검증하지 않습니다. Python 허용 목록은 프로그램과 이름을 검사하며 물리 해의 성공을 보장하지 않습니다. 필요한 관련 CAE 검사도 로컬에서 수행합니다.
6. **빌드된 입력을 살펴봅니다.** 고정된 변수, 명시적 Material 모델 스냅샷, Task 식별 정보, 형상과 진단을 확인합니다. 형상이나 선택 대상을 바꿨다면 구조 PNG를 만듭니다. 미리보기 메시의 모양과 Solver 입력·수치법·기록 계약의 정확성은 각각 확인해야 합니다.
7. **원본 식별 정보로 저장합니다.** 업로드 전에 메타데이터를 갱신합니다. 소스가 잠겼거나 revision 충돌이 나면 현재 소스를 받아 변경을 비교하거나 의도한 새 버전을 만듭니다. 다른 revision을 조용히 덮어쓰거나 이름만 바꾸지 않습니다. 소스와 로컬 빌드 산출물은 각각의 업로드 계약을 따릅니다.
8. **작은 해석부터 확인합니다.** 배치 제출 전에 모든 입력을 로컬에서 빌드하고, 배치 전체의 소스 해시와 Catalog revision을 고정합니다. 작업 종료와 RecordedData 저장을 기다린 뒤 오류·필수 기록·수치를 확인합니다. 빌드 성공, 작업 성공, 기록 결과 검증을 구분하고 모두 확인한 뒤 실행 규모를 늘립니다.

### 입력 연결 점검표

- Geometry 사용자 속성은 매개변수에서 직접 구조 분해하고 기본값을 지정합니다. 계속 참조할 형상에는 안정적인 ID를 붙이고 Element별 표면 slot을 확인합니다.
- Task의 `config`와 요청 artifact는 현재 Solver descriptor에 맞춥니다. Material 모델과 모든 계수는 `material.tsx`에 정의합니다. 이름만으로 외부 계수를 불러오지 않으며 `vars`를 바꾸면 모델 파라미터도 다시 구성됩니다.
- `modelGroups`의 각 필수 그룹에는 대상 Material마다 지원 모델 인스턴스 하나가 필요합니다. 후보가 여러 개이면 `config.materialModels[role][materialName][groupKey]`로 선택합니다.
- 수치 Output은 Experiment 또는 Task Geometry의 Box 하나를 대상으로 하며 `gridShape`가 필요합니다. 회전도 지원합니다. 두 Geometry 장면은 별개이며 물리적 상호작용은 Solver가 정의합니다.
- RecordedData는 `{ task, output }` 참조로만 선언하고 `sim.record`에는 이 선언과 일치하는, 아직 해제하지 않은 Box Grid 출력을 전달합니다.
- 해석 간 연결에 쓰는 native artifact는 Task의 `config.exports`에 선언합니다. 메시·광선 표시 자료는 자동 포함됩니다. 이 두 종류는 RecordedData로 기록하거나 Calculation에 전달하지 않습니다.

실패하면 단계, 메시지, 제공된 파일·위치 정보, 소스 해시와 job·Measurement ID를 보관하고 `diagnostic.experiment`를 확인합니다. 메시지만 반환한 소스 정책 오류에 임의의 줄 번호를 붙이지 않습니다. 소스나 Catalog를 바꾸면 다시 빌드하며, 재시도가 같은 입력에 대한 것인지 조건을 바꾼 새 실행인지 구분합니다.

Catalog 데이터의 단일 원본은 `app/catalog/caemble_catalog/catalog.sqlite3`입니다. 기존 Catalog Python 라이브러리로 읽으며 JSON·TS·Markdown 복사본이나 별도 Node SQLite 어댑터를 만들지 않습니다. 사용자 안내는 웹 문서와 CLI가 공유하는 Markdown에, 구현·운영 지침은 개발·운영 문서에 작성합니다.

## 예제를 검사하고 로컬에서 실행하기

목록에서 실제 예제 키를 고른 뒤 아래 `REPLACE_WITH_LISTED_EXAMPLE_KEY`를 바꿉니다. `agent context`가 안내하는 참조 ID와 후속 명령을 따라 필요한 내용을 확인합니다.

```powershell
.\caemble.cmd doctor
.\caemble.cmd agent guide experiment
.\caemble.cmd catalog show examples
$exampleKey = 'REPLACE_WITH_LISTED_EXAMPLE_KEY'
.\caemble.cmd experiment init .work/experiment --example $exampleKey
.\caemble.cmd agent context experiment --source .work/experiment
.\caemble.cmd reference show experiment.contract
.\caemble.cmd reference show experiment.simulate
# 전체 소스 묶음을 수정한 뒤 검사하고 산출물을 보관합니다.
.\caemble.cmd experiment check .work/experiment --vars-mode nominal --out .work/checked
.\caemble.cmd png geometry .work/checked --out .work/geometry.png
.\caemble.cmd experiment test .work/checked --out .work/local-results --timeout 120
.\caemble.cmd data inspect --result .work/local-results/1
```

`check`와 `build`는 소스·타입 검사, 로컬 입력 구성과 기존 Python의 `simulate.py` 검증을 수행합니다. **둘 다 Solver를 실행하지 않습니다.** `check --out`은 `build`와 같은 형식의 산출물을 만들므로 위의 `.work/checked`를 그대로 재사용할 수 있습니다.

`experiment test`는 그 산출물로 로컬 Solver를 실행합니다. 서버 배치를 만들거나 소스를 업로드하지 않습니다. 결과의 manifest, 기록과 예상 수치를 확인한 뒤 다음 단계로 넘어갑니다. 실행 중 Ctrl+C를 누르면 로컬 취소와 자원 정리를 요청합니다.

## 서버에 저장하고 원격 실행하기

기존 서버 실험을 수정한다면 `init` 대신 `experiment pull <id> --out <empty-directory>`를 사용합니다. 내려받은 디렉터리를 수정하며 `caemble.json`의 `baseBundleHash`를 유지합니다. 새 실험은 이 메타데이터에서 원하는 namespace·repository·key를 정합니다. 다음 명령은 실제 서버 저장과 원격 실행을 수행하므로 로컬 결과를 확인한 뒤 필요한 경우에 진행합니다.

```powershell
.\caemble.cmd doctor --api
$saved = .\caemble.cmd experiment push .work/experiment --artifact .work/checked --json | ConvertFrom-Json
$batch = .\caemble.cmd batch submit .work/checked --experiment $saved.id --json | ConvertFrom-Json
.\caemble.cmd batch watch $batch.id
.\caemble.cmd batch show $batch.id
```

`push`는 원본 식별 정보에 맞춰 소스를 저장하고 지정한 산출물이 소스와 일치하는지 확인합니다. `batch submit`은 이미 빌드한 큰 입력 바이트를 S3에 직접 올린 뒤 원격 배치에 참조를 등록합니다. 로컬 Solver 실행이나 재빌드는 하지 않습니다. 위 로컬 검사와 서버 제출은 같은 `.work/checked`를 사용합니다.

`watch`는 진행 상태를 관찰합니다. **Ctrl+C나 관찰 시간 초과로 watch를 종료해도 원격 배치는 계속 실행됩니다.** 취소가 필요하면 `batch cancel <batch-id>`를 사용합니다. `batch show`가 반환한 Measurement ID를 `measurement inspect <measurement-id>`로 조회하고, 저장된 기록을 내려받아 수치를 확인합니다.

### 배치 목록과 작업을 나누어 조회하기

`batch list`는 개별 작업 없이 배치 요약을 반환하며 기본적으로 **최근 50개**를 읽습니다. 이전 목록은 `--limit`와 `--offset`으로 조회하고 `--experiment <id>`로 특정 실험만 고를 수 있습니다.

`batch show <batch-id>`는 기본적으로 **작업 100개**를 반환하며 같은 `--limit`와 `--offset`으로 나누어 조회합니다. `batch show <batch-id> --limit 0`은 배치 상태와 집계만 읽고 `jobs`는 빈 배열로 반환합니다. 작업의 Measurement ID를 찾을 때는 양의 `--limit`를 사용합니다.

### 여러 조건으로 확장하기

작은 검사에 성공하면 `experiment build .work/experiment --count 10 --vars-mode random --out .work/batch-build`로 조건을 늘리고 `batch submit .work/batch-build --experiment <saved-experiment-id>`로 제출합니다. 10개 입력을 모두 로컬에서 빌드·검증한 뒤 제출하며, 재시도와 검토를 위해 `.work/batch-build`를 보관합니다.

소스, 변수, 명시적 Material 모델 스냅샷 또는 Catalog를 바꾸면 다시 빌드합니다. 다른 소스나 Catalog 식별 정보의 산출물을 재사용하지 않습니다. 소스가 잠긴 경우 `push`의 `--new-version patch|minor|major` 중 의도한 변경 수준을 선택하고 반환된 Experiment ID를 사용합니다.

## 예제 Calculation 등록과 동반 저장

Catalog Draft의 `catalogctl --database <draft.sqlite3> experiment upsert ... --bundle-file <bundle.json> --calculations-file <calculations.json>`으로 예제 Version에 Calculation을 등록합니다. Calculation 파일은 `name`, 선택적 `description`, `source_code`를 가진 객체의 JSON 배열입니다. 예제 안에서 이름은 중복될 수 없습니다. 파일을 생략하면 기존 목록을 유지하고, 빈 배열을 지정하면 목록을 비웁니다. 이 파일은 등록 입력이며 최종 카탈로그 데이터는 SQLite에만 보관합니다. 기존 Draft는 `catalogctl --database <draft.sqlite3> rebase` 후 사용하고 검증한 Draft를 publish합니다.

예제 상세 조회에는 `calculations`가 포함됩니다. `experiment init --example ...`은 이를 로컬 `caemble.json`에 함께 보관하고 최초 `experiment push`에서 Experiment와 한 번에 저장합니다. `--new-version`으로 저장하면 서버의 선택한 원본 Version에 저장된 Calculation을 복사합니다. 이름·설명·코드만 복사되므로 대상 Measurement로 Calculation preflight를 다시 수행해야 합니다. 기존 예제에 Calculation 등록은 필수가 아닙니다.

Experiment source와 Record 계약의 덮어쓰기 잠금은 Measurement 존재 여부만으로 결정합니다. Calculation만 있는 Experiment는 덮어쓸 수 있으며, source 또는 Record 계약 변경 시 Calculation 검증 상태가 초기화됩니다.

## 기록된 결과의 축과 표시 자료 이해하기

수치 Output은 항상 `x, y, z, time, frequency, amplitudePhase, component` 순서의 일곱 축을 가집니다. 사용하지 않는 축도 길이 1로 남습니다. 실수는 `value` 채널, 복소수는 진폭과 위상이라는 두 실수 채널로 표현하며 위상의 단위는 rad입니다.

공간 point 표본은 Box cell 중심에 놓이며 길이가 1인 축도 중심을 사용합니다. Box 안의 절점만 선택하는 방식이 아니라 풀어진 장에서 표본을 구하고, 해석 영역 밖의 위치는 0으로 기록합니다. 정적 결과 계약에는 후보마다 달라지는 형상을 넣지 않습니다. 대신 각 저장 tensor가 실제 Box의 변환, 크기, `gridShape`와 식별 정보를 가지므로 전체 결과를 내보낼 때 이 정보를 보존합니다.

변형 재생에는 자동 포함된 구조 메시와 사용 가능한 절점 변위 이력을 확인합니다. 메시나 광선용 Output·Record 선언은 필요하지 않습니다. Task별 마지막 성공 호출이 표시 스냅샷을 제공하며 승인된 물리 시간 이력은 그 안에 남습니다. 겹쳐 보기와 확인 방법은 [결과 기록과 변형 재생](../manual/program/program-domain-recording.md)을 참고합니다.

## 재료 사이의 상호작용 정의하기

`material.tsx`에서 `MaterialInteraction`을 export하고 `between`에 Material 쌍, `models`에 모델 인스턴스를 지정합니다. 같은 재료끼리의 쌍을 포함해 순서 없는 재료 쌍마다 하나의 선언을 사용하며 서로 다른 모델도 이 객체에 함께 둡니다. Experiment에 별도 interaction 목록을 만들 필요는 없습니다.

평가된 Experiment·Task Geometry에서 사용하는 쌍만 입력에 포함되지만 export한 선언은 모두 검증됩니다. `({ vars }) => ({ between, models })` 형태는 Candidate(변수값을 적용한 실행 후보)마다 한 번 평가합니다. 필요하면 클래스 타입 인자로 Vars 타입을 지정합니다.

Catalog 모델의 `subject`로 단일 재료 모델과 재료 쌍 모델을 구분합니다. 같은 그룹에 지원 모델이 여러 개이면 Task의 `config.interactionModels[role][interactionName][group]`으로 선택합니다. 선택 그룹의 기본 동작은 Solver 계약을 따릅니다. 고정된 입력에는 `interactions`와 Task별 `interactionSelections`가 포함되며 다시 실행할 때 이 선택을 확인합니다. [재료와 상호작용](../manual/program/program-materials.md) 및 Catalog의 미끄럼 접촉 예제로 전체 구성을 확인합니다.

## 큰 변형 solid의 최종 평형

압축성 초탄성 FEM은 Geometry와 Material, Surface의 고정·지정 변위 조건으로
정의합니다. 현재 지원 조합과 실행 가능한 압축·인장 예제는 Catalog에서
`hyperelastic`을 검색해 확인합니다. 같은 Neo-Hookean Material은 MPM에서도
사용할 수 있지만, FEM의 정적 평형과 MPM의 임의 시각 동적 상태는 서로 다릅니다.

Candidate 하나는 vars로 지정한 최종 하중·변위 하나의 평형을 계산합니다.
Solver 내부의 하중 증분은 수렴 절차이며 시간 이력으로 기록하지 않습니다.
서로 다른 하중 조건은 기존 vars와 Batch 흐름으로 계산합니다.

지정 변위는 선택한 world x/y/z 성분만 구속합니다. 예를 들어 x만 지정하면
나머지 방향은 자유롭습니다. 0 고정과 서로 다른 지정 변위를 같은 자유도에
겹치거나, 종속 연결 Surface에 지정하면 오류가 발생합니다. `fea.pressure`는
기준 면적·법선으로 정의한 하중입니다. `fea.follower-pressure`는 현재 면적과
법선을 따라가는 압력이며 양수가 압축입니다. 두 조건 모두 최종 압력을 vars로
정의할 수 있습니다.

기준 배치 출력은 원래 재료 위치에서, 현재 배치 출력은 변형 후 공간 위치에서
관측합니다. 기본 응력은 Cauchy 응력이며, MPM의 재료 체적 가중 평균과 FEM의
요소 내 sampling은 구분됩니다. Viewer의 배치·가중 평균 표시를 확인합니다.
변위·응력·체적비·전체 변형에너지와 FEM 반력은 기존 RecordedData와 Calculation,
Prediction에서 사용합니다. Native 변형구배·제1 Piola 응력은 연성용 값입니다.

거의 비압축성 재료에는 `solidFormulation: 'mixed-mini'`를 명시합니다. 기본값인
`displacement`는 기존 변위 기반 tet4이며 Poisson 비에 따라 자동 전환하지 않습니다.
MINI는 하나의 Material을 공유하는 3D solid와 `0 < nu < 0.5`, 정적 큰 변형에서
지원합니다. 사용자가 내부 절점이나 압력을 지정하지 않습니다. 실행 가능한
압축·원통 내압 예제는 Catalog에서 `mixed-mini`를 검색합니다.

평균압은 Cauchy 응력의 `-trace(stress)/3`으로 계산하며 압축이 양수입니다.
내부 보조장 q와 경계의 외부 압력은 이 평균압과 다른 값입니다.
`strain-energy`는 FEM·MPM 공통의 `integral W(F) dV0` 의미를 유지합니다.
`equilibrium-energy`는 MINI의 보조장을 제거한 이산 에너지로, 반력과 외부 일의
검증에 사용합니다. 유한한 메시에서 두 에너지가 달라도 한쪽을 보정하지 않습니다.
이 에너지들은 Box 전체 공간을 필터로 사용하지 않는 전체 모델 집계값입니다.

MINI의 기준·현재 관측에는 요소 내부 bubble 변형을 포함합니다. Native 셀 값은
기준 체적 가중 평균이며 표시용 압력 smoothing을 하지 않습니다. 공간 정련으로
변위·반력·압력·에너지 수렴을 확인합니다. 완전 비압축성 `nu=0.5`, 다중 Material
MINI, 초탄성 동적·고유치 해석과 접촉·연결은 지원 범위에 포함되지 않습니다.

## 다음으로 읽을 문서

- [프로그램 구성](../manual/program/program-overview.md): 파일 사이의 관계와 작성 순서를 확인합니다.
- [실행 순서 작성](../manual/program/program-simulate.md): 여러 Task의 실행, 기록과 자원 해제를 작성합니다.
- [Calculation 작성하기](calculation.md): 기록된 수치에서 비교 지표를 만들고 결과를 검증합니다.
