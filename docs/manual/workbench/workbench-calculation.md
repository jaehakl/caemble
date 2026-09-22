# Calculation으로 결과 계산하기

**Calculation**은 Solver가 기록한 결과에서 필요한 값을 구하는 계산식입니다. 예를 들어 여러 위치의 값을 평균하거나, 한 축에 따른 변화를 그래프로 정리할 수 있습니다. 계산식은 JavaScript로 작성하며, 저장한 후처리 결과는 **CalculationData**라고 부릅니다.

## 먼저 결과 하나로 시작하기

결과가 기록된 **Recorded Measurement**가 필요합니다. 아직 실행하지 않았다면 [빠른 시작](workbench-quickstart.md)을 먼저 따라 해 보세요. 예제에 Calculation이 포함되어 있다면 기존 계산식을 열어 입력과 반환값을 살펴보는 것이 좋습니다.

1. **Calculation** 탭에서 **Measurement**를 열고 Recorded Measurement를 선택합니다.
2. **Calculations**에서 기존 계산식을 고르거나 **새 Calculation**으로 초안을 만듭니다.
3. **ExperimentRecord**에서 실제 데이터가 **Ready**인 항목을 확인합니다. 새 참조가 필요할 때만 편집기에서 넣을 위치를 고른 뒤 해당 행의 **Insert**를 누르세요.
4. 코드를 확인하거나 수정하고 오른쪽 **Return** 차트에서 결과를 살펴봅니다. 필요하면 **미리보기 갱신**을 누릅니다.
5. 결과가 맞으면 **저장**으로 계산식을 저장합니다. 여러 Measurement의 계산 결과까지 남기려면 **후처리 데이터**에서 필요한 범위를 계산합니다.

변수 조건 변경과 Solver 실행은 **Measurement** 탭에서 진행합니다. Calculation에서는 이미 기록된 데이터로 계산하므로 후처리 코드를 바꿀 때마다 Solver를 다시 실행할 필요는 없습니다.

## 미리보기와 두 가지 저장 구분하기

| 작업 | 남기는 것 | 사용하는 곳 |
| --- | --- | --- |
| 코드 편집과 미리보기 | 현재 Measurement에 대한 임시 반환값 | 계산식의 동작과 그래프 확인 |
| Calculation **저장** | 이름·설명·소스·입력 의존성·검증된 출력 규격 | 계산식 재사용과 Prediction 설정 |
| **후처리 데이터** 계산 | 저장된 Calculation과 Measurement별 CalculationData | Analysis, 결과 비교와 재사용 |

### 계산식 저장

**저장**을 누르면 이름과 설명을 입력하는 창이 열립니다. 새 계산식이나 소스를 바꾼 계산식, 아직 출력 규격이 검증되지 않은 기존 계산식은 선택한 Recorded Measurement에서 최신 미리보기가 성공해야 저장할 수 있습니다.

저장할 때는 정확한 소스의 해시, 참조하는 ExperimentRecord 이름, 사전 검증(preflight)에 사용한 Measurement, 출력의 자료형(dtype)·배열 크기(shape)·축(axes)을 함께 기록합니다. 이후 실행 결과도 이 규격을 따라야 합니다. 이름이나 설명만 바꾸고 소스는 같다면 기존 검증 결과를 재사용합니다.

저장하지 않은 코드도 편집 후 500ms가 지나면 선택한 Measurement로 자동 실행합니다. 이때 차트에 나타나는 Output은 데이터베이스에 저장되지 않습니다.

### 후처리 결과 저장

리본의 **후처리 데이터**에서 저장 범위를 고릅니다. 미저장 또는 수정 중인 계산식 초안은 일괄 계산에 사용하지 않습니다.

| 버튼 | 계산하고 저장할 범위 |
| --- | --- |
| **Selected Calc** | 선택한 Calculation과 아직 결과가 없는 Recorded Measurement의 조합 |
| **Selected Measurement** | 현재 Measurement와 저장된 모든 Calculation의 미저장 조합 |
| **All Missing** | 전체 Calculation·Measurement의 미저장 조합 |

진행 중에는 완료 수와 현재 대상을 표시합니다. **Cancel Data**로 남은 작업을 취소해도 이미 저장한 성공 결과는 유지됩니다. 일부 조합이 실패해도 성공한 결과는 남습니다.

> 저장된 계산식의 **소스**를 변경하면 이전 소스로 만든 CalculationData가 자동 삭제되어 다시 미저장 상태가 됩니다. 이름이나 설명만 바꾸면 기존 결과를 유지합니다.

### 완료 상태 읽기

Measurement 목록의 점은 **회색: Solver 실행 전**, **노란색: Recorded이지만 후처리 미완료**, **초록색: 저장된 모든 Calculation의 후처리 완료**를 뜻합니다. 점에 포인터를 올리면 `완료 수/전체 수`를 볼 수 있으며 같은 정보가 접근성 레이블에도 제공됩니다.

저장된 Calculation이 하나도 없다면 Recorded Measurement는 `0/0 완료`로 초록색입니다. Calculation 목록을 읽는 중이거나 조회에 실패하면 Recorded 점은 중립색으로 표시됩니다.

브라우저에서 Solver 실행을 관찰하고 있으면 RecordedData 저장 후 기존 Calculation의 후처리를 이어서 실행합니다. CAE 배치의 완료는 RecordedData 저장을 기준으로 하며, 후처리 실패는 별도로 Console에 표시합니다. 브라우저를 닫으면 제출된 Solver 작업은 계속되지만 브라우저의 후처리는 중단되고 재접속만으로 자동 재개되지 않습니다. **All Missing** 등으로 빠진 결과를 계산하세요.

## 화면과 입력 데이터 살펴보기

왼쪽부터 3D Viewer, 소스 편집기, Return 차트와 로그가 배치됩니다. 기본 열 비율은 30:40:30이며 오른쪽 차트와 로그는 65:35입니다. 경계선을 드래그하거나 키보드 방향키로 크기를 조절할 수 있으며 마지막 Workbench 작업에 저장됩니다.

**Measurement**와 **Calculations** 버튼으로 목록을 열고, 리본에서 현재 선택을 확인합니다. Calculation 삭제는 목록에서 진행하며, 저장하지 않은 코드가 있다면 다른 Calculation으로 바꾸기 전에 확인합니다.

**ExperimentRecord**에는 Experiment에 선언된 모든 결과 이름이 표시됩니다. **Used**는 현재 코드가 참조하는 항목이며, **RecordedData Ready/Missing/Invalid**는 선택한 Measurement에 실제 값이 준비되었는지를 뜻합니다. 이름으로 검색할 수 있고 **Insert**는 `record["group.signal"]`처럼 고정된 이름의 참조를 편집기의 선택 위치에 넣은 뒤 목록을 닫습니다. 행 자체를 누르면 코드는 바뀌지 않습니다.

오른쪽 아래 `console.log`는 읽기 전용 로그입니다. 코드나 선택이 바뀌면 이전 로그를 지우고 현재 실행의 내용을 호출 순서대로 표시합니다. 오류가 나기 전의 로그는 남고, 출력 한도에 도달하면 안내합니다. 공통 Console에도 실행 활동이 기록됩니다.

반환값이 숫자 하나라면 다른 Measurement에 저장된 같은 CalculationData를 Histogram으로 보여 주고, 현재 미리보기의 위치를 주황색 표시로 겹칩니다. 새 계산식이나 수정 중인 초안, 비교 데이터가 없는 경우에는 현재 반환값만 차트에 표시합니다.

## 계산식과 입력 데이터 규칙

소스는 순수 JavaScript의 동기 `default export` 함수 하나로 작성합니다. TypeScript 문법과 JSX는 사용할 수 없고, 외부 함수는 `mathjs`의 named import로만 가져올 수 있습니다. 편집기는 허용된 함수의 사용법을 안내하고 실행할 때 입력과 출력 규격을 검증합니다.

디버깅에는 `console.log(...)`, `console['log'](...)`, `const log = console.log`를 사용할 수 있습니다. console 객체는 수정할 수 없고 다른 console API는 제공하지 않습니다. 허용되지 않는 코드는 밑줄로 표시되며 Return 영역과 로그에서 줄·열, 이유와 코드 조각을 확인할 수 있습니다. 자동 미리보기는 편집 중인 커서나 스크롤을 오류 위치로 옮기지 않습니다.

```js
{{calculation.source}}
```

Experiment를 저장하면 Box Grid 결과의 이름과 규격이 **ExperimentRecord**로 함께 저장됩니다. 여기에는 물리량(QuantityKind), 텐서 차수(tensorOrder), 자료형(dtype), 7차원 데이터 규격과 정적 `boxGrid` 정보가 있습니다. 각 Measurement의 RecordedData는 이 규격의 ID와 실제 텐서값, 실행 당시의 Box 형상을 담습니다. 자동으로 표시되는 메쉬·광선 경로나 Solver 간 전달용 데이터는 Calculation의 입력이 아닙니다.

입력 `record`는 ExperimentRecord 이름으로 값을 찾는 읽기 전용 객체입니다. `record.signal`, `record['group.signal']`, 고정된 이름의 구조 분해와 추적 가능한 `const` 별칭으로 필요한 항목을 지정하세요. `record[key]`처럼 이름을 실행 중에 고르거나, 전체 입력을 열거·복사·전달·반환·재할당하거나, 존재하지 않는 이름을 쓰면 오류 위치를 안내하고 저장을 거부합니다.

각 결과 항목에는 다음 정보가 있습니다.

- `dtype`: float32 또는 float64입니다.
- `shape`와 `axes`: `[x, y, z, time, frequency, amplitudePhase, component]`의 일곱 축을 모두 유지합니다. 성분은 마지막 축에 들어가므로 별도 차원을 붙이지 않습니다.
- `data`: 행 우선(row-major) 순서로 펼친 값입니다.
- `boxGrid`, `quantityKind`, `tensorOrder`, `unit`: 관측 격자와 물리량, 값의 단위 정보입니다.

복소수 결과는 진폭과 위상의 두 채널로 읽으며 위상 단위는 rad입니다. 입력 축의 길이는 실제 shape와 일치하지만 좌표값(ticks)은 숫자 또는 문자열일 수 있습니다. 기본 템플릿이 반환하는 원본 축에 문자열 ticks가 있다면 출력 오류가 납니다. 의미에 맞게 숫자로 바꾸거나 출력의 `axes`를 생략해 순번 축을 사용하세요.

### Tensor 연산

RecordedData의 펼쳐진 배열은 Math.js `reshape`로 원래 텐서 모양을 복원할 수 있습니다. 마지막 축부터 `mean`으로 평균을 구하면 필요한 축만 남길 수 있습니다.

아래는 연산 방법을 보여 주는 **부분 예시**입니다. `import`는 파일 맨 위에, 나머지는 `default export` 함수 안에 둡니다. `signal`은 실제 Record 이름으로 바꾸고, 선택 범위가 데이터 크기 안에 있는지 확인하세요. 완전한 실행 예제와 입력값은 CLI의 `reference show calculation.example.mean`, `calculation.example.line`, `calculation.example.heatmap`에서 확인할 수 있습니다.

```js
import { index, map, mean, range, reshape, subset, transpose } from 'mathjs'

const source = record.signal
const flat = Array.isArray(source.data) ? source.data : [source.data]
let tensor = reshape(flat, source.shape.length > 0 ? source.shape : [1])

// 첫 두 축만 유지하고 나머지 축을 평균합니다.
for (let axis = source.shape.length - 1; axis >= 2; axis -= 1) {
  tensor = mean(tensor, axis)
}

// 영역 선택, element-wise 변환, 축 교환
const window = subset(tensor, index(range(0, 10), range(0, 20)))
const doubled = map(window, (value) => value * 2)
const swapped = transpose(doubled)

// 동적으로 계산한 숫자 index도 일반 bracket 문법으로 읽고 쓸 수 있습니다.
const base = 2
const sample = flat[base]
```

`reshape`는 배열 모양 변경, `mean`/`sum`은 축을 따라 평균·합계 구하기, `subset`과 `index`는 범위 선택, `map`은 각 원소 변환에 사용합니다. `transpose`와 `squeeze`로 축을 정리할 수 있습니다. 빈 축의 2차원 크기를 유지해야 한다면 `zeros(rows, columns)`를 반환할 수 있습니다.

### 반환값과 차트

반환하는 Output에는 `dtype`, 유한한 실수값인 `data`, 필요할 때 지정하는 `axes`만 작성합니다. `shape`는 값에서 자동으로 결정하므로 직접 쓰면 오류가 납니다. Output에는 QuantityKind나 값의 unit 필드가 없습니다.

| 반환 데이터 | 추론되는 shape | 표시 방식 |
| --- | --- | --- |
| 숫자 하나 | `[]` | 스칼라 |
| 1차원 배열 | `[length]` | 선 그래프 |
| 직사각 2차원 배열 | `[rows, columns]` | Heatmap |
| 직사각 3차원 배열 | `[rows, columns, depth]` | 3D Point cloud |
| Math.js Matrix | `size()`로 결정 | 해당 차원에 맞는 차트 |

`axes`를 생략하면 `index` 또는 `row`/`column`/`depth`라는 순번 축을 만듭니다. 축을 직접 지정한다면 모든 축의 좌표값(ticks)이 유한한 숫자여야 하고, 개수도 추론된 shape와 일치해야 합니다. 저장 후에는 검증된 dtype·shape·축 이름·단위를 지켜야 하지만, 좌표값 자체는 Measurement마다 달라도 됩니다. 각 결과는 실제 좌표를 보존해 표시합니다.

Prediction의 Predicted·Target·Re-predicted·Actual 비교는 shape가 같으면 같은 배열 인덱스끼리 수행합니다. 축 좌표·이름·단위나 숫자 dtype이 달라도 비교하며, 겹쳐 표시할 때는 Predicted 또는 Target의 축을 사용합니다. 좌표 보간이나 단위 변환은 하지 않으므로 같은 인덱스를 비교하는 것이 의미에 맞는지 확인하세요.

2차원 Heatmap은 열:행 비율을 유지해 셀을 정사각형으로 표시하고 차트 영역에 맞춰 확대합니다. 숫자 축 레이블은 최대 유효숫자 5개로 표시하지만 포인터를 올려 확인하는 좌표와 Return 데이터는 원본 정밀도를 유지합니다.

### 허용 Math.js API

{{calculation.mathjs}}

`mathjs`의 위 목록에 있는 함수를 named import로 가져오세요. 다른 패키지와 default/namespace/deep/dynamic import, `require`는 허용하지 않습니다. 수식 파서·기호 연산·설정 변경, BigNumber/Fraction/Unit, 난수 함수도 사용할 수 없습니다. stdlib는 현재 v1에 포함되지 않습니다.

배열은 `values[index]`처럼 실행 중 계산한 인덱스로 읽고 쓸 수 있습니다. 인덱스는 0 이상의 JavaScript 안전 정수여야 합니다. 문자열·BigInt·NaN·Infinity·음수·소수이면 코드 위치를 포함한 오류를 표시합니다. 고정된 `record['path.to.leaf']`는 허용하지만 `record[path]`처럼 실행 중 결정하는 문자열 속성, 계산된 이름의 객체 속성·메서드 선언은 허용하지 않습니다.

`constructor`, `prototype`, `__proto__`, 실행 중 이름을 고르는 Math 속성, 난수 함수, 내장 `Object`/`Array`의 별칭과 전역 객체·네트워크·저장소·타이머·Worker 접근도 제한합니다.

### 오류와 한도

- 전체 입력은 64 MiB 이하, 출력은 수치 원소 5,000,000개 이하여야 합니다.
- 한 번의 계산은 최대 30초입니다. 소스, Measurement, Calculation 또는 Experiment가 바뀌면 이전 계산을 취소합니다.
- 직접 작성한 `shape`, 빠진 축, ticks 개수 불일치, 유효하지 않은 UCUM 축 단위는 출력 규격 오류입니다.
- `console.log`는 호출당 4 KiB, 실행당 100건·64 KiB까지 표시합니다. 초과하면 잘렸다는 경고를 한 번 표시합니다.
- `timeout`이면 계산량을 줄이세요. `input-too-large`이면 필요한 RecordedData만 생성하도록 Experiment를 나누세요. `output-too-large`이면 표본 수를 줄이거나 값을 집계해 0~3차원 결과를 반환하세요.

## Viewer 변환 코드 복사

Viewer에서 원하는 그래프를 이미 만들었다면 **변환 코드 복사**로 같은 변환을 Calculation에 가져올 수 있습니다. 현재 채널·성분·축·집계 설정이 `boxGrid.project` 한 줄로 복사됩니다. 별도 import 없이 Calculation 함수 안에서 `return`을 붙여 실행하세요. 입력 매개변수 이름은 현재 함수에 맞추고 Record 이름은 고정된 참조로 유지합니다. 아래 `signal`은 실제 결과 이름으로 바꾸어 사용하세요.

```js
export default function calculate(record) {
  return boxGrid.project(record['signal'], { axes: ['time'], component: 0 });
}
```

`axes`는 남길 축과 반환 순서입니다. `x`, `y`, `z`, `time`, `frequency`를 사용할 수 있고 빈 배열이면 숫자 하나를 반환합니다. `representation`은 `amplitude`(기본) 또는 `phase`, `component`는 0부터 시작하는 성분 번호 또는 `magnitude`입니다. 위상에는 성분 하나를 지정합니다. 실수 스칼라의 기본값은 성분 0이며 부호를 유지합니다.

`reduce`는 표시하지 않는 각 축을 어떻게 줄일지 정하는 `{ method, index? }` 설정입니다. `sum`, `mean`(기본), `min`, `max`, `median`, `std`, `index`를 지원합니다. 표본별 성분이나 크기를 계산한 뒤 x→y→z→time→frequency 순서로 집계합니다. sum은 표본의 합, std는 모집단 표준편차입니다. 위상도 rad 단위 숫자로 같은 집계를 적용합니다. index는 0부터 시작합니다.

```js
export default function calculate(record) {
  return boxGrid.project(record['signal'], { axes: ['x', 'y', 'z'], component: 'magnitude', reduce: { time: { method: 'index', index: 0 }, frequency: { method: 'mean' } } });
}
```

재생 중 변환 코드를 복사하면 현재 `frame.timeSeconds`(초) 또는 `frame: { axis: 'time', index: 0 }`를 고정합니다. 공통 시간의 진동은 주파수를 Hz로 바꾸어 `A_f,c*cos(φ_f,c+2πf t)`로 계산하며 0 Hz의 값은 일정합니다. 주파수의 sum/mean은 성분별 순간값을 먼저 합성하고 벡터 크기를 구한 뒤 나머지 축을 집계합니다. mean은 주파수 표본 수로 나눕니다.

다른 집계와 정적 표시는 기존 축소 순서를 유지합니다. 과거의 `frame.phase`(rad)도 지원하지만 `timeSeconds`와 함께 지정할 수는 없습니다. 화살표 보기는 X·Y·Z·벡터 크기의 변환식 네 줄을 복사합니다. 원하는 식 하나를 반환하거나 중간 변수에 넣어 사용하세요.

Histogram에서 복사하는 값은 채널·성분 축을 제외한 `[x,y,z,time,frequency]`의 **5차원 중간 결과**입니다. 순회하는 축은 길이 1로 보존합니다. 5차원 값은 그대로 반환할 수 없으므로 추가 계산으로 0~3차원까지 줄이세요. 모든 변환은 float64의 `{ dtype, data, axes }`를 반환합니다. 실행 가능한 예제는 CLI `reference show calculation.example.projection`에서도 확인할 수 있습니다.
