# Calculation으로 RecordedData 후처리

상단 **Calculation** 메뉴는 왼쪽부터 Measurements/Vars·Experiment Records & RecordedData·Calculation 목록, 3D Viewer, Source Editor, Output Chart를 표시합니다. 첫 패널의 **Measurements / Vars** 탭은 현재 화면 세션 동안 선택을 유지합니다. 가운데 통합 카탈로그에는 Experiment가 선언한 모든 ExperimentRecord가 표시되며 **Used**는 현재 source가 참조하는 Record, **RecordedData Ready/Missing/Invalid**는 선택 Measurement의 실제 값 상태를 뜻합니다. 이름으로 검색할 수 있고 각 행의 **Insert**를 누르면 현재 Source Editor selection에 `record["group.signal"]` 형식의 고정-key 참조를 삽입합니다. 행 자체를 누르는 것은 source를 변경하지 않습니다. 3D Viewer 아래에는 공통 Console 도크가 있으며 Calculation의 `console.log`와 실행 오류도 이 Console에 누적됩니다. 우측 열은 Output Chart와 Return 요약을 기본 65/35로 나눕니다. 열 경계, 왼쪽 세 영역, 하단 도크와 Chart/Return 경계는 드래그하거나 키보드 방향키로 조절하며 마지막 Workbench draft에 저장됩니다. Viewer를 확장하면 왼쪽 목록과 Viewer 열을 합쳐 full height Viewer로 사용하고, Source Editor와 Output 열은 계속 표시합니다.

**Vars**는 현재 `varsSchema`의 key를 선언 순서대로 카드에 표시합니다. 별도 팝업 없이 카드를 누르면 그 자리에서 편집기가 펼쳐지며, 한 번에 하나만 열립니다. Candidate 값이 갱신되어도 열린 카드는 유지되고 Experiment 또는 varsSchema가 바뀔 때만 접힙니다. scalar와 1-D Tensor는 schema min/max 고정 축의 막대그래프로, 2-D Tensor는 같은 범위의 heatmap으로 편집합니다. N-D Tensor는 마지막 두 축을 heatmap으로 사용하고 앞 축 index 조합을 8개씩 페이지로 표시합니다. rank 2 이상 heatmap은 로컬 툴바에서 **Brush**, **Eraser**, **Region + Wheel**, **Region + Value**를 선택합니다. Brush는 지나간 원형 영역에 strength를 계속 더하므로 덧칠할수록 진해지고, Eraser는 reset tensor의 해당 cell로 복원합니다. **Reset**은 전체 Tensor에 적용하며 **Undo/Redo**는 Tensor별 최근 20개 commit을 유지합니다. Region + Wheel은 범위의 1%, Shift 10배, Alt 0.1배이고 Region + Value는 Apply 또는 Enter 때 한 번 반영됩니다. 모든 값은 허용 범위 안으로 제한됩니다.

Vars를 바꾸면 기존 scene 평가를 취소하고 최신 Candidate로 다시 평가해 Viewer를 갱신합니다. 저장된 Measurement를 편집한 경우 원본 Measurement를 수정하지 않고 선택을 해제한 새 editable Candidate가 되며 Material 소스도 새 vars로 다시 평가합니다. **Save Current**는 이를 새 Prepared Measurement로 저장하고, **Save & Run**은 저장 후 같은 vars로 즉시 실행합니다. 저장이 완료된 뒤 평가나 실행이 실패해도 Prepared Measurement는 남으며 Simulation 시작 후에는 Cancel할 수 있습니다.

Calculation 리본의 **Save**를 누르면 이름과 설명을 입력하는 저장 모달이 열리고 현재 source와 함께 명시적으로 저장합니다. 새 Calculation, source가 바뀐 Calculation, 기존의 미계약 Calculation은 선택한 Recorded Measurement에서 최신 preview가 성공해야 저장할 수 있습니다. 저장 시 source hash, 정적으로 확인한 ExperimentRecord dependency, preflight Measurement와 Output의 dtype·정확한 shape·axes가 하나의 고정 계약으로 기록됩니다. 이름이나 설명만 바뀌고 source hash가 같으면 기존 계약을 재사용합니다. 저장하지 않은 source도 선택 Measurement에 대해 500ms 뒤 자동 실행하지만 Output은 DB에 저장하지 않습니다.
Calculation 리본의 **Calculation Data** 그룹에서는 **Selected Calc**로 선택 Calculation과 모든 미저장 Recorded Measurement를, **Selected Measurement**로 현재 Measurement와 모든 저장 Calculation을, **All Missing**으로 전체 미저장 조합을 순차 계산해 저장합니다. 진행 중에는 완료 수와 현재 대상을 표시하며 **Cancel Data**로 남은 작업을 취소할 수 있습니다. 이미 저장된 성공 결과는 취소나 일부 실패가 발생해도 유지됩니다.
Calculation 탭의 Measurement 점은 **회색=Run 전**, **노란색=Recorded이지만 Calculation 미완료**, **초록색=모든 저장 Calculation 완료**를 뜻합니다. 점의 tooltip과 접근성 label에는 `완료 수/전체 수`가 표시됩니다. 저장된 Calculation이 하나도 없으면 Recorded Measurement는 `0/0 완료`이므로 초록색입니다. Calculation 목록을 확인하는 중이거나 조회에 실패하면 Recorded 점은 중립색으로 표시됩니다.
**Save & Run**, **Generate & Run**, **Repeat Run**, 기존 Measurement의 **Run**은 열린 브라우저에서 해당 실행을 관찰하는 동안 RecordedData 저장 후 기존 CalculationData 후처리를 순차 실행합니다. CAE batch 완료는 RecordedData 저장을 기준으로 표시하며 CalculationData 오류는 별도로 Console에 남습니다. 브라우저를 닫으면 후처리는 중단되고 재접속만으로 자동 재개되지 않습니다. 필요한 데이터는 **All Missing** 또는 선택 Calculation의 Missing 실행으로 계산하세요. Prediction의 Sample & Run 반복도 브라우저에 남으며 재접속 시 자동 재개되지 않습니다.
저장된 Calculation source를 변경하면 이전 source로 만든 CalculationData는 자동 삭제되어 다시 미저장 상태가 됩니다. 이름이나 설명만 바꾼 경우에는 유지됩니다. 미저장 또는 수정 중인 draft는 일괄 계산 대상이 아닙니다.
현재 Output이 scalar이면 다른 Measurement에 저장된 같은 CalculationData를 Histogram으로 표시하고 현재 선택 Measurement의 최신 preview 위치를 주황색 marker로 겹쳐 표시합니다. 새 Calculation이나 수정 중인 draft에서는 서로 다른 source 결과를 섞지 않도록 Histogram을 숨깁니다.



Source는 순수 JavaScript의 동기 `default export` 함수 하나여야 합니다. TypeScript 문법과 JSX는 허용하지 않으며, package import는 `mathjs`의 named import만 허용합니다. Editor는 허용된 Math.js 함수 signature를 안내하고 입력과 Output 계약은 실행 과정에서 검증합니다. 디버깅에는 frozen console의 `log`만 사용할 수 있으며 `console.log(...)`, `console['log'](...)`, `const log = console.log` 같은 alias를 지원합니다. 다른 console API는 허용하지 않습니다.
Source policy 오류가 발생하면 Editor가 문제가 된 코드를 밑줄로 표시하고 Output Chart와 Console에 줄·열, 거부 이유와 코드 조각을 표시합니다. 자동 preview는 오류 위치로 커서나 스크롤을 이동시키지 않습니다.

```js
{{calculation.source}}
```

Experiment를 저장하면 컴파일된 Box Grid RecordedData 선언이 이름별 **ExperimentRecord** 계약으로 함께 저장됩니다. QuantityKind, tensorOrder, dtype, 7차원 data schema와 정적 `boxGrid` profile은 이 계약에서 제공됩니다. Measurement의 RecordedData는 ExperimentRecord ID, 실제 tensor 값과 실행 당시 Box geometry를 저장합니다. 자동 mesh·ray 시각화와 native coupling export는 ExperimentRecord나 Calculation dependency가 아닙니다.

Calculation 입력은 ExperimentRecord 이름을 key로 쓰는 읽기 전용 map입니다. `record.signal`, `record['group.signal']`, 정적 object destructuring과 추적 가능한 `const` alias만 dependency로 허용합니다. `record[key]`, `Object.keys/values/entries(record)`, spread, Record 전체 전달·반환, 재할당과 존재하지 않는 key는 정확한 source 위치가 있는 저장 오류입니다. 각 leaf에는 float32/float64 `dtype`, 정확히 7차원인 `shape`, row-major flat `data`, `[x, y, z, time, frequency, amplitudePhase, component]` 전체 `axes`, `boxGrid`, `quantityKind`, `tensorOrder`, 값 `unit`이 있습니다. Component는 마지막 축에 포함되며 별도 차원을 덧붙이지 않습니다. 복소수는 진폭·위상 두 채널로 읽고 위상 단위는 rad입니다.
Calculation에 전달되는 axis는 실제 shape와 정확히 맞지만 ticks는 숫자 또는 문자열일 수 있습니다. 기본 템플릿은 원본 axis를 그대로 반환하므로 문자열 ticks는 Output 계약 오류가 됩니다. 필요한 경우 ticks를 숫자로 변환하거나 Output에서 `axes`를 생략해 ordinal axis를 사용하세요.

### Tensor 연산

RecordedData의 flat row-major data는 Math.js `reshape`로 원래 tensor shape를 복원할 수 있습니다. 고차원 결과는 마지막 축부터 `mean`을 적용하면 원하는 축만 남길 수 있습니다.

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

`reshape`는 shape 변경, `mean`/`sum`은 축약, `subset`과 `index`는 slicing, `map`은 element-wise 변환, `transpose`와 `squeeze`는 축 정리에 사용합니다. 빈 축의 2차원 shape를 유지해야 할 때는 `zeros(rows, columns)`를 반환할 수 있습니다.

작성하는 Output은 `dtype`, finite real `data`, 선택적인 `axes`만 가집니다. `shape`를 작성하면 오류이며 scalar는 `[]`, flat array는 `[length]`, 직사각 2D array는 `[rows, columns]`, Math.js Matrix는 `size()`에서 자동 추론합니다. axes를 생략하면 `index` 또는 `row`/`column` ordinal ticks를 생성하고, 제공하면 모든 축과 ticks 길이가 추론 shape에 정확히 맞아야 합니다. 성공한 preflight의 dtype·shape·축 이름·단위는 저장 뒤 강제 계약이 됩니다. 축 좌표(ticks)의 값은 Measurement마다 달라도 저장할 수 있으며, 각 결과의 실제 좌표를 보존해 표시합니다. ticks는 유한한 숫자이고 개수가 해당 shape와 일치해야 합니다. Prediction의 예측 결과 계약 검사도 같은 규칙으로 Measurement별 좌표 차이를 허용하지만, Predicted·Target·Re-predicted·Actual의 비교는 shape가 같으면 같은 배열 인덱스끼리 수행합니다. 축 좌표·이름·단위·숫자 dtype 차이는 비교를 막지 않으며, 겹쳐 표시할 때는 Predicted 또는 Target의 축을 사용합니다. 보간이나 단위 변환은 하지 않습니다. Output에는 QuantityKind와 값 unit이 없습니다. rank 0은 scalar, rank 1은 line, rank 2는 heatmap으로 표시합니다.
2차원 heatmap은 tensor의 columns:rows shape 비율을 유지해 각 cell을 정사각형으로 표시하며, Output Chart의 가용 영역과 splitter 조절에 맞춰 확대됩니다. 숫자 축 라벨은 최대 유효숫자 5개로 반올림하지만 hover 좌표와 Return 데이터는 원본 정밀도를 유지합니다.

### 허용 Math.js API

{{calculation.mathjs}}

`mathjs` 이외 package, default/namespace/deep/dynamic import, `require`, expression parser와 symbolic API, mutable configuration, BigNumber/Fraction/Unit, random 함수는 허용하지 않습니다. stdlib는 v1에 포함되지 않습니다.
`values[index]` 같은 동적 bracket index는 실행 시 `number`, 0 이상, safe integer인지 검사한 뒤 허용합니다. 문자열·BigInt·NaN·Infinity·음수·소수 index는 source 위치가 포함된 policy 오류가 됩니다. 고정된 `record['path.to.leaf']`는 계속 허용하지만 `record[path]` 같은 동적 문자열 property와 computed object property/method 선언은 차단합니다. `constructor`, `prototype`, `__proto__`, 동적 Math member, random 함수, native `Object`/`Array` alias와 global·network·storage·timer·Worker 접근도 허용하지 않습니다.

### 오류와 한도

- 전체 입력은 64 MiB 이하여야 합니다.
- Output은 최대 5,000,000개의 수치 원소를 가질 수 있습니다.
- 한 실행은 최대 30초이며 source, Measurement, Calculation 또는 Experiment가 바뀌면 이전 실행을 취소합니다.
- 명시적인 `shape`, 불완전한 axes, ticks 길이 불일치, 유효하지 않은 UCUM axis unit은 Output 계약 오류입니다.
- `console.log`는 호출당 4 KiB, 실행당 100건·64 KiB로 제한되며 초과분은 한 번의 truncation 경고로 대체됩니다.
- `timeout`은 계산량을 줄이고, `input-too-large`는 필요한 RecordedData만 만드는 Experiment 계약으로 나누고, `output-too-large`는 downsample 또는 aggregate한 rank 0/1/2 결과를 반환해 해결합니다.
