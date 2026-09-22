# CLI로 Calculation 작성하고 검증하기

Calculation(후처리 계산)은 실험에서 기록한 수치 데이터를 읽어 평균, 비교 지표나 그래프용 데이터를 만듭니다. 여기서는 정답이 있는 작은 예제로 코드를 확인하고, 실제 해석 결과에 적용한 뒤 서버에 저장하는 순서로 진행합니다. 화면에서 작성하는 방법은 [Calculation 사용법](../manual/workbench/workbench-calculation.md)을 참고합니다.

## 시작 전에 준비할 것

아래 명령은 Caemble 저장소 루트의 **PowerShell 7**을 기준으로 합니다. 먼저 `.\caemble.cmd doctor`를 실행합니다. CLI가 없거나 오래된 경우 `npm --prefix app/ui run build:cli`로 빌드하고 다시 확인합니다. POSIX에서는 `sh ./caemble`을 사용합니다. 소스는 **BOM 없는 UTF-8**로 저장하며, 예제의 `.work/calculation`은 비어 있는 디렉터리를 사용합니다.

코드를 쓰기 전에 대상 ExperimentRecord(기록 이름과 데이터 형식), 기록이 저장된 Measurement, 실제로 사용할 수 있는 Output을 확인합니다. 기존 Calculation을 수정한다면 현재 소스와 원본 해시도 확인합니다. 기록 형식이 정의되어 있어도 모든 Measurement에 해당 데이터가 있다는 뜻은 아닙니다.

Calculation 입력은 실수 배열로 표현한 **일곱 축의 Box Grid Output**입니다. 메시, 광선 경로, 표시 자료의 구성원과 native 연성 export는 입력으로 사용할 수 없습니다.

## 코드와 결과의 기본 규칙

1. **정확한 언어 참조를 확인합니다.** `calculation.contract`와 `calculation.declarations`를 읽습니다. JavaScript에 선택적으로 JSDoc을 사용하며, 식별자 매개변수 하나를 받는 동기 함수 선언을 정확히 하나 default export합니다. 배포된 Math.js 목록의 named import만 사용합니다. TypeScript 타입 표기, default export한 화살표 함수, `async` 함수, 동적 import와 일반 Node·브라우저 코드는 지원하지 않습니다. 일부 Math.js 선언의 `any`는 실행 시 배열 모양이나 수치 동작을 보장하지 않습니다.
2. **필요한 기록 이름을 소스에 명시합니다.** `record.signal` 또는 `record['group.signal']`처럼 접근합니다. 고정된 객체 구조 분해와 추적 가능한 `const` 별칭도 사용할 수 있습니다. 입력 전체를 열거·전개하거나 helper에 넘기지 않고, 기록 이름을 동적으로 고르지 않습니다. 잎 배열 내부의 동적 숫자 인덱스는 별개이며 음이 아닌 안전한 정수만 허용됩니다. 의존성 분석에는 실제 ExperimentRecord 이름을 사용합니다.
3. **완전한 입력으로 재현합니다.** `float32`·`float64` dtype, 일곱 축의 전체 shape와 행 우선 순서의 평탄한 데이터, axes·ticks, `quantityKind`, 단위, `boxGrid` profile과 실제 후보 형상을 보존합니다. 일곱 번째 축에 이미 모든 성분이 들어 있으므로 `tensorOrder` 차원을 추가하지 않습니다. Experiment·Measurement·RecordedData ID, 소스 해시, Catalog revision과 내용 해시는 별도의 출처 정보에 보관합니다. 일부만 잘라 보여 준 미리보기는 실행용 스냅샷이 아닙니다. 이미 정규화한 전체 스냅샷은 Catalog 어댑터 없이 오프라인으로 실행할 수 있습니다.
4. **수치 가정을 정합니다.** 완전한 `calculation.js`, Box Grid 입력, 예상 출력을 가진 검증 예제에서 시작합니다. 예제의 고정된 `signal` 의존성을 실제 기록 이름으로 바꿉니다. 축을 줄이기 전에 sampling, 성분과 `channelUnits`를 확인합니다. 진폭과 위상은 단위가 서로 다릅니다.
5. **검사와 실행을 모두 확인합니다.** 소스 규칙, 의존성 분석과 타입 검사는 서로 다른 오류를 찾습니다. CLI의 일회용 자식 프로세스에서 시간과 로그를 제한해 공통 컴파일 런타임을 실행합니다. dtype, 유한한 값, 추론된 rank·shape, 숫자 축과 단위를 확인하고 적어도 하나의 관련 입력에서 예상 수치를 검증합니다. 서버 저장 전에는 실제 서버 입력으로 다시 확인합니다.
6. **출력 모양을 확인합니다.** 스칼라는 축 없이 표시되고 1차원은 선 그래프, 2차원은 열 지도, 3차원은 점 구름으로 표시됩니다. 정규화된 출력의 방향·순서·크기를 확인한 뒤 PNG를 봅니다. 최종 출력은 유한한 실수의 0·1·2·3차원 데이터여야 합니다. 길이가 일정하지 않은 중첩 배열, 복소수 최종값과 명시적인 `shape` 필드는 거부됩니다. 입력의 차원이 더 높으면 목적에 맞게 축을 줄입니다.
7. **검증한 대상에 저장합니다.** 소스를 바꾸어 저장하려면 선택한 서버 데이터로 preflight(저장 전 검사)에 성공해야 합니다. 이 실행의 소스 해시, 정확한 의존성 목록과 dtype·shape·axes 구성을 보존합니다. 오프라인 예제의 성공으로 서버 preflight를 대신할 수 없습니다. 원본 충돌 시 현재 코드를 받아 비교하거나 의도한 새 Calculation으로 저장합니다. 후처리 결과는 해당 소스와 Measurement의 조합에만 저장합니다.

검증 기록에는 입력 예제의 식별 정보·해시, 소스 해시, 의존 기록 이름, 컴파일·실행 상태, 출력 구성, 수치 확인 결과와 제한된 로그를 남깁니다. 오류는 `diagnostic.calculation`에서 소스 규칙·컴파일·입력·실행·시간 초과·출력 단계별로 확인합니다. 시간 초과나 유효하지 않은 출력을 성공으로 처리하지 않습니다. 공통 함수만 직접 호출하면 프로세스 시간 제한이 생기지 않으므로 실행은 일회용 프로세스에서 수행합니다.

## 1. 정답이 있는 작은 예제 실행하기

`reference show`의 구조화된 `example` 필드에는 자동 검사와 같은 소스, 완전한 입력과 정규화된 예상 출력이 들어 있습니다. 아래 예제는 평균을 계산하며 정답은 스칼라 **5**입니다.

```powershell
.\caemble.cmd doctor
.\caemble.cmd agent guide calculation
.\caemble.cmd calculation init .work/calculation
.\caemble.cmd agent context calculation --source .work/calculation
$example = .\caemble.cmd reference show calculation.example.mean --json | ConvertFrom-Json
Set-Content -LiteralPath .work/calculation/calculation.js -Value $example.example.source -Encoding utf8NoBOM -NoNewline
$example.example.input | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath .work/calculation/input.json -Encoding utf8NoBOM
.\caemble.cmd calculation check .work/calculation/calculation.js
$fixtureRun = .\caemble.cmd calculation run .work/calculation/calculation.js --fixture .work/calculation/input.json --out .work/fixture-result.json --json | ConvertFrom-Json
if ($fixtureRun.output.data -ne $example.example.expected.data) { throw '평균 계산 결과가 예상값과 다릅니다.' }
```

선 그래프와 열 지도 참조에도 각각 전체 소스·입력·예상값이 있습니다. `check`는 실행 없이 소스 규칙과 JavaScript·JSDoc 타입을 검사합니다. `run`은 선택한 입력에서 고정 의존성을 확인하고 제한 시간 안에서 실행한 뒤 출력을 검증합니다. **두 명령 모두 Calculation 정의나 CalculationData를 저장하지 않습니다.**

## 2. 실제 로컬 해석 결과에 적용하기

먼저 로컬 결과의 기록 이름과 형식을 확인합니다. 소스가 그 이름과 물리적으로 의미 있는 연산을 사용하도록 수정합니다. 작은 예제에서 사용한 `signal`이 실제 Catalog 출력에도 있다고 가정하지 않습니다.

```powershell
.\caemble.cmd data inspect --result .work/local-results/1
.\caemble.cmd agent context calculation --source .work/calculation --result .work/local-results/1
# 실제 기록에 맞춰 calculation.js를 수정하고 예상 수치를 확인합니다.
.\caemble.cmd calculation run .work/calculation/calculation.js --result .work/local-results/1 --out .work/local-calculation.json
.\caemble.cmd png calculation .work/local-calculation.json --out .work/local-calculation.png
.\caemble.cmd data export --result .work/local-results/1 --out .work/result-export
```

내보낸 디렉터리에는 Box Grid 기록값, 자동 표시 자료, 바이너리 첨부와 소스 묶음·해시를 포함한 정확한 빌드 입력이 들어 있습니다. Calculation은 이 중 수치 기록만 읽습니다. 전체 디렉터리를 다른 위치로 옮긴 뒤에도 `--result`로 지정해 조회·부분 조회·Calculation·PNG 출력에 사용할 수 있습니다. 내보내기는 재빌드하거나 Solver를 실행하지 않습니다.

## 3. 서버 입력으로 검증하고 정의 저장하기

서버의 `experiment list`와 완료된 배치·Measurement 메타데이터에서 실제 ID를 고릅니다. API 접속용 `.env`를 설정한 뒤 `doctor --api`를 실행합니다. 기존 Calculation을 수정한다면 `calculation pull <id> --out <empty-directory>`로 먼저 내려받고 `caemble.json`의 revision을 유지합니다. 아래 `REPLACE_...` 값을 실제 ID로 바꿉니다.

```powershell
$experimentId = 'REPLACE_WITH_SERVER_EXPERIMENT_ID'
$measurementId = 'REPLACE_WITH_RECORDED_MEASUREMENT_ID'
.\caemble.cmd doctor --api
.\caemble.cmd agent context calculation --source .work/calculation --experiment $experimentId --measurement $measurementId
.\caemble.cmd calculation run .work/calculation/calculation.js --measurement $measurementId --out .work/server-calculation.json
.\caemble.cmd calculation run .work/server-calculation.json.source.js --fixture .work/server-calculation.json.input.json --out .work/replay.json
.\caemble.cmd calculation push .work/calculation --experiment $experimentId --measurement $measurementId
```

`run --out`은 결과 파일과 함께 `.input.json`, `.source.js`를 만듭니다. 세 파일을 함께 보관합니다. `source_hash`는 정확한 소스 바이트, `input_hash`는 직렬화한 전체 정규화 입력을 식별하며 `provenance`는 선택한 입력 예제·로컬 결과·서버 Measurement의 출처를 기록합니다.

서버 실행을 저장한 결과와 오프라인 재실행의 `source_hash`, `input_hash`, 출력을 비교한 뒤 같은 계산인지 판단합니다. 재실행에는 편집 중인 초안 대신 당시 함께 저장한 소스 파일을 사용합니다. 입력 예제만으로는 서버 출처를 알 수 없으므로 원래 결과 파일도 함께 유지합니다.

`push`는 서버에 Calculation 정의를 저장하며 필수 `--measurement`로 지정한 서버 데이터를 사용해 preflight를 새로 수행합니다. 오프라인 실행 성공으로 이 단계를 대신할 수 없습니다. Measurement는 대상 Experiment에 속하고 기록된 데이터가 있어야 합니다. 오래된 revision으로 충돌이 나면 다시 내려받아 변경을 비교한 뒤 저장합니다.

## 4. 후처리 결과 저장하기

정의 저장과 후처리 결과 저장은 별개입니다. 저장된 Calculation·Measurement 조합의 결과를 보관하려면 먼저 `calculation-data missing --experiment <id>`로 누락된 결과를 확인하고, `calculation-data run --experiment <id> --calculation <id> --measurement <id>`를 실행합니다. 이 명령이 **CalculationData를 저장**합니다.

| 목적                         | 명령                   | 서버에 저장하는 것      |
| ---------------------------- | ---------------------- | ----------------------- |
| 코드 검사                    | `calculation check`    | 없음                    |
| 계산 실행과 결과 확인        | `calculation run`      | 없음                    |
| 후처리 정의 저장             | `calculation push`     | 검증한 Calculation 정의 |
| 특정 실행의 후처리 결과 저장 | `calculation-data run` | CalculationData         |

## Calculation 삭제하기

`calculation delete <id...> --experiment <id>`는 지정한 Calculation을 삭제합니다. CLI는 실제 삭제 전에 모든 ID가 양의 정수이며 선택한 Experiment에 속하는지 확인합니다.

삭제하면 관련 CalculationData도 함께 없어집니다. 보관할 소스는 `calculation pull`, 저장된 결과는 `calculation-data export`로 먼저 내보냅니다. 성공 시 `experiment_id`와 `deleted_ids`를 반환합니다. 존재하지 않는 ID, Experiment 불일치나 API 실패는 0이 아닌 종료 코드로 알립니다.

## 복소수 RecordedData 다루기

복소 물리량은 0부터 센 축 인덱스 5에 실수 진폭·위상 채널로 저장됩니다. `channelUnits`는 각각 물리량의 단위와 rad를 나타냅니다. 축 순서는 `x, y, z, time, frequency, amplitudePhase, component`입니다. 길이 1인 축도 유지하며 `{ re, im }` 객체가 들어 있다고 가정하지 않습니다.

실수부·허수부가 필요하면 `re = amplitude * cos(phase)`, `im = amplitude * sin(phase)`로 복원합니다. 진폭 0의 저장 위상은 0이며 방향에 관한 위상 정보를 담지 않습니다. 스펙트럼 장의 표본은 결과 이름에 적힌 파장이 아니라 frequency 축의 ticks로 선택합니다.

Forward Prediction은 Box Grid 전체를 예측한 후 Calculation을 실행합니다. 후보마다 다른 Box는 정규화한 로컬 위치끼리 대응하며, 예측 입력에는 현재 후보의 실제 Box 형상을 복원합니다. 메시·광선 표시 자료는 학습이나 Calculation 입력에 포함되지 않습니다.

## 결과가 예상과 다를 때

기록이 없다는 오류가 나면 선택한 Measurement에 해당 Record가 실제로 저장되었는지 먼저 확인합니다. 배열 모양이나 단위가 다르면 축을 줄이기 전의 전체 shape, 성분과 `channelUnits`를 확인합니다. 정의 저장이 실패한다면 서버 Measurement의 소속·기록 상태와 수정 원본의 revision을 점검합니다. 구체적인 진단은 `reference show diagnostic.calculation`에서 확인합니다.

## 다음으로 읽을 문서

- [Experiment 작성하기](experiment.md): 입력과 기록을 정의하고 로컬 해석 결과를 만듭니다.
- [결과 기록 구조](../manual/program/program-domain-recording.md): Box Grid, 축과 표시 자료의 차이를 확인합니다.
- [Calculation 화면 사용법](../manual/workbench/workbench-calculation.md): 미리보기와 정의·결과 저장을 화면에서 진행합니다.
