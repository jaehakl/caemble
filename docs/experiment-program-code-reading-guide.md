# Experiment Program v3 코드 읽기 튜토리얼

이 문서는 Caemble 프론트엔드의 CAD v3 Experiment 실행 코드를 직접 읽고 이해하기 위한 안내서다.
특히 다음 흐름을 실제 코드 위치와 연결해서 설명한다.

```text
Experiment Source 작성
→ TypeScript/TSX compile
→ Structure/Experiment evaluate
→ simulation preflight
→ simulate() orchestration
→ kernel prepare/execute
→ typed artifact와 state 관리
→ Experiment RecordedData 확정
→ Viewer 표시
→ Measurement 저장
```

이 문서를 처음부터 끝까지 한 번 읽은 뒤, 각 절의 “직접 확인할 코드” 순서대로 소스를 열어보는 것을 권장한다.

---

## 1. 먼저 기억할 핵심 그림

전체 코드는 크게 네 층으로 나뉜다.

```text
┌─────────────────────────────────────────────────────────────┐
│ 1. Authoring                                                │
│ Experiment Source, experiment(), dcCurrentDensity()         │
└─────────────────────────────┬───────────────────────────────┘
                              │ compile/evaluate
┌─────────────────────────────▼───────────────────────────────┐
│ 2. Frontend orchestration                                   │
│ useCadWorkspace, runner client, Worker protocol             │
└─────────────────────────────┬───────────────────────────────┘
                              │ preflight/run request
┌─────────────────────────────▼───────────────────────────────┐
│ 3. Simulation runtime                                       │
│ sim.run, ArtifactRef, StateRef, record, release, rollback    │
└─────────────────────────────┬───────────────────────────────┘
                              │ prepare/execute
┌─────────────────────────────▼───────────────────────────────┐
│ 4. Kernel                                                   │
│ descriptor → prepare → execute → numerical implementation   │
└─────────────────────────────────────────────────────────────┘
```

가장 중요한 구분은 다음과 같다.

| 개념                  | 의미                                             | 소유자             |
| --------------------- | ------------------------------------------------ | ------------------ |
| `tasks`               | 실행 가능한 kernel 작업 선언                     | Experiment         |
| `task.outputs`        | kernel에 계산을 요청하는 중간 결과 목록          | 각 task            |
| `result.artifacts`    | 다음 kernel이나 `sim.record()`에 전달하는 handle | simulation runtime |
| `result.observations` | 반복 종료와 분기에 사용하는 작은 값              | kernel             |
| `StateRef`            | kernel별 내부 상태 snapshot을 가리키는 handle    | simulation runtime |
| `recordedData`        | Measurement에 최종 저장할 결과 schema            | Experiment 전체    |
| `sim.record()`        | artifact를 최종 RecordedData로 승격              | `simulate()`       |
| `sim.release()`       | 더 이상 필요 없는 중간 artifact 해제             | `simulate()`       |

`task.outputs`와 Experiment `recordedData`는 서로 다른 것이다.

- `task.outputs`는 계산 중 필요한 중간 artifact를 요청한다.
- Experiment `recordedData`는 계산이 성공했을 때 외부로 공개할 최종 결과를 선언한다.
- 중간 artifact는 `sim.record()`하지 않는 한 Viewer나 Measurement에 나타나지 않는다.

---

## 2. 가장 짧은 읽기 코스

처음부터 모든 파일을 읽으면 compiler, React lifecycle, 수치해석 코드가 한꺼번에 섞여 어렵다.
아래 여섯 파일만 먼저 읽으면 전체 구조를 빠르게 잡을 수 있다.

1. [`defaultExperimentProgramCode.ts`](../src/lib/defaultExperimentProgramCode.ts)
   - 사용자가 작성하는 Experiment Source의 완성된 예시다.
   - `tasks`, `recordedData`, `simulate`의 관계만 먼저 본다.

2. [`model/v3.ts`](../src/lib/cad/model/v3.ts)
   - `experiment({...})`가 무엇을 만들고, task와 simulate를 어떻게 보관하는지 본다.
   - 특히 `ExperimentDefinitionOptions`와 `createProgramRuntime()`을 읽는다.

3. [`useCadWorkspace.ts`](../src/features/viewer/workspace/useCadWorkspace.ts)
   - 프론트엔드가 compile, evaluate, preflight, run을 어떤 순서로 호출하는지 본다.
   - 처음에는 `compiledSourceFor()`, preflight `useEffect`, `run()`만 읽는다.

4. [`simulation/runtime.ts`](../src/lib/simulation/runtime.ts)
   - `sim.run()`, `sim.record()`, `sim.release()`의 실제 의미가 들어 있다.
   - 이 파일이 multiphysics 계약의 중심이다.

5. [`dcCurrentDensity/descriptor.ts`](../src/lib/simulation/kernels/dcCurrentDensity/descriptor.ts)
   - DC kernel이 허용하는 method, parameter, target, output schema를 본다.

6. [`dcCurrentDensity/index.ts`](../src/lib/simulation/kernels/dcCurrentDensity/index.ts)
   - authoring 함수와 실제 kernel definition이 어떻게 하나로 연결되는지 본다.

이후 세부 구현은 다음 순서로 내려간다.

```text
descriptor.ts
→ prepare.ts
→ execute.ts
→ numeric.ts
```

---

## 3. 출발점: 사용자가 작성하는 Experiment Source

먼저 [`defaultExperimentProgramCode.ts`](../src/lib/defaultExperimentProgramCode.ts)를 연다.

전체 모양은 다음과 같다.

```ts
export default experiment({
  varsSchema: { ... },

  tasks: ({ vars }) => ({
    electric: dcCurrentDensity({
      parameters: { ... },
      initializations: [ ... ],
      boundaryConditions: [ ... ],
      outputs: [ ... ],
    }),
  }),

  recordedData: {
    measuredCurrent: { ... },
  },

  simulate: async ({ sim, tasks }) => {
    const electric = await sim.run(tasks.electric)
    sim.record('measuredCurrent', electric.artifacts.totalCurrent)
    sim.release(electric.artifacts.currentDensity)
    return electric.state
  },
})
```

### 3.1 `tasks`

`tasks`는 vars가 확정된 뒤 실행할 kernel task들을 만든다.

```ts
tasks: ({ vars }) => ({
  electric: dcCurrentDensity({ ... }),
})
```

여기서 `dcCurrentDensity()`는 solver를 즉시 실행하지 않는다.
kernel identity와 task config를 가진 `DefinedKernelTask`를 만들 뿐이다.

실제 구현은 [`simulation/authoring.ts`](../src/lib/simulation/authoring.ts)의
`defineKernelTask()`에서 확인할 수 있다.

### 3.2 `recordedData`

`recordedData`는 task 내부가 아니라 Experiment 최상위에 있다.

```ts
recordedData: {
  measuredCurrent: {
    dtype: 'float64',
    unit: 'A',
    quantityKind: 'electromagnetism.ElectricCurrent',
  },
}
```

이는 “이 Experiment가 성공하면 `measuredCurrent`라는 결과를 정확히 한 번 만들어야 한다”라는 계약이다.
아직 값은 없고 schema만 있다.

### 3.3 `simulate`

`simulate()`가 실제 실행 순서를 결정한다.

```ts
const electric = await sim.run(tasks.electric)
sim.record('measuredCurrent', electric.artifacts.totalCurrent)
sim.release(electric.artifacts.currentDensity)
return electric.state
```

중요한 점:

- task 선언 순서가 실행 순서가 아니다.
- `sim.run()`을 호출한 순서가 실행 순서다.
- 어떤 artifact를 다음 kernel에 넘길지 `simulate()`가 직접 결정한다.
- runtime은 kernel을 자동 연결하지 않는다.
- 일반 JavaScript의 `for`, `if`, `try/catch`를 그대로 사용할 수 있다.

따라서 multiphysics도 별도 workflow DSL 없이 다음 형태로 작성한다.

```ts
const electric = await sim.run(tasks.electric)
const thermal = await sim.run(tasks.thermal, {
  state: electric.state,
  inputs: {
    heatSource: electric.artifacts.jouleHeating,
  },
})

sim.record('temperature', thermal.artifacts.temperature)
sim.record('maximumTemperature', thermal.artifacts.maximumTemperature)
sim.release(electric.artifacts.jouleHeating)
```

현재 production catalog의 `dc-current-density@0.0.0`과 `steady-state-heat@0.0.0`이 위 흐름을 그대로 실행한다.

---

## 4. `experiment({...})`는 무엇을 만드는가

다음으로 [`model/v3.ts`](../src/lib/cad/model/v3.ts)를 읽는다.

### 4.1 타입 계약

`ExperimentDefinitionOptions`에서 authoring API 전체를 볼 수 있다.

```ts
type ExperimentDefinitionOptions = {
  tasks: (context) => Tasks
  recordedData: Recorded
  simulate: ({ sim, tasks, vars, world }) => Promise<StateRef> | StateRef
}
```

여기서 TypeScript generic이 다음을 연결한다.

- `tasks()`가 반환한 task 이름
- 각 task의 input port
- 각 output key의 artifact type
- observation 이름과 타입

예를 들어 DC task의 output에 `key: 'totalCurrent'`를 선언하면
`electric.artifacts.totalCurrent`가 타입에 나타난다.

### 4.2 `ExperimentDefinition`

`ExperimentDefinition` 생성자는 다음 세 요소를 보관한다.

- `tasksFactory`
- 동결된 `recordedData`
- `simulateFactory`

아직 kernel을 실행하지 않는다.

### 4.3 `createProgramRuntime()`

실행 직전에 `createProgramRuntime(vars, programHash)`가 호출된다.

이 함수는:

1. 확정된 vars로 `tasksFactory`를 실행한다.
2. task 이름과 `caemble-kernel-task` 표식을 확인한다.
3. task config와 RecordedData schema로 manifest를 만든다.
4. 사용자 `simulate()`를 runtime이 호출할 수 있는 형태로 감싼다.

manifest에는 다음 정보가 들어간다.

```text
programHash
tasks.<taskName>.kernel
tasks.<taskName>.configHash
recordedData
```

preview 시 만들어진 manifest와 Run 직전에 다시 만든 manifest가 같아야 실행된다.
따라서 화면에서 확인한 Experiment revision과 실제 실행 코드가 달라지는 것을 막는다.

---

## 5. 여기서 “compile”은 구체적으로 무엇인가

compile의 진입점은 [`compiler/monacoCompiler.ts`](../src/lib/cad/compiler/monacoCompiler.ts)의
`compileCadDocument()`다.

### 5.1 입력과 출력

입력:

```text
단일 structure.tsx 또는 experiment.tsx Source
```

출력:

```ts
type CompiledCadSource = {
  apiVersion: 3
  compilerVersion: ...
  entryFile: 'structure.tsx' | 'experiment.tsx'
  code: string
  sourceMap?: string
  sourceHash: string
}
```

즉, compile은 TSX source를 브라우저 Worker에서 실행 가능한 CommonJS JavaScript 문자열로 바꾸는 작업이다.
geometry나 전류밀도 tensor로 바꾸는 단계가 아니다.

```text
TSX/TypeScript Source
→ 정책 검사
→ TypeScript syntax/semantic type 검사
→ JavaScript emit
→ CompiledCadSource
```

### 5.2 import 정책 검사

compile 전에 [`source/sourceAnalysis.ts`](../src/lib/cad/source/sourceAnalysis.ts)가 AST를 검사한다.

허용되는 공개 import는 두 개뿐이다.

```ts
import { ... } from '@caemble/core'
import { ... } from '@caemble/kernels'
```

다음은 거부된다.

- 상대 import
- 다른 package import
- dynamic `import()`
- source-level `require()`
- Structure Source의 `@caemble/kernels` import
- 정적으로 찾을 수 없는 default export

### 5.3 compile cache

`compileCadDocument()`는 다음 키로 Promise 자체를 cache한다.

```text
compilerVersion + sourceHash
```

같은 source revision에서 vars나 seed만 바뀌면 JavaScript를 다시 만들지 않고 기존 compiled source를 재평가한다.
cache는 최대 32개 항목을 유지한다.

이 동작은 [`useCadWorkspace.test.tsx`](../src/features/viewer/workspace/useCadWorkspace.test.tsx)의
“compiles once for a source revision” 테스트에서 확인할 수 있다.

### 5.4 compile과 evaluate의 차이

둘은 반드시 구분해야 한다.

| 단계        | 변환                                                           |
| ----------- | -------------------------------------------------------------- |
| compile     | TSX/TypeScript → JavaScript                                    |
| module load | JavaScript → `StructureDefinition` 또는 `ExperimentDefinition` |
| evaluate    | Definition + vars/seed → CAD scene와 simulation manifest       |
| preflight   | task config + 실제 scene/material → 실행 가능 여부             |
| run         | `simulate()`와 kernel 실행 → `SimulationResult`                |

---

## 6. compiled code는 어디서 실행되는가

실행 경계는 세 파일을 순서대로 읽는다.

1. [`runner/client.ts`](../src/lib/cad/runner/client.ts)
2. [`runner/frame.ts`](../src/lib/cad/runner/frame.ts)
3. [`runner/evaluation.worker.ts`](../src/lib/cad/runner/evaluation.worker.ts)

브라우저 main UI가 직접 사용자 코드를 실행하지 않는다.

```text
React UI
→ isolated runner iframe
→ disposable simulation Worker
→ compiled Experiment와 모든 kernel 실행
```

### 6.1 client

`client.ts`는 iframe과 `MessageChannel`을 만들고 다음을 검증한다.

- nonce
- requestId
- Structure revision
- Experiment revision
- 응답 type

startup에는 10초 제한이 있지만 kernel 계산 전체에는 고정 30초 제한이 없다.
실행 중에는 progress와 사용자 cancel을 사용한다.

### 6.2 Worker

`evaluation.worker.ts`의 `programForSimulation()`은 compiled Experiment를 다시 load한다.

```ts
const entry = loadCompiledSource(compiledSource, 'experiment')
return entry.createProgramRuntime(vars, compiledSource.sourceHash)
```

그 다음:

- preflight 요청이면 `preflightSimulation()`
- run 요청이면 `runSimulationProgram()`

을 호출한다.

중간 artifact payload는 이 Worker 밖으로 `postMessage`되지 않는다.
외부로 나오는 것은 progress, 최종 RecordedData, 작은 trace와 provenance뿐이다.

---

## 7. React 쪽 실행 관리자: `useCadWorkspace`

[`useCadWorkspace.ts`](../src/features/viewer/workspace/useCadWorkspace.ts)는 프론트엔드에서 가장 중요한 연결 파일이다.
길기 때문에 위에서부터 읽지 말고 다음 순서로 읽는 편이 쉽다.

### 7.1 `compiledSourceFor()`

역할:

- document 종류별 compiled source slot 관리
- 같은 source면 compile Promise 재사용
- compile 실패 시 cache slot 제거

Monaco compiler 자체의 global cache와 별도로 workspace 수준에서도 현재 Structure/Experiment compiled source를 보관한다.

### 7.2 `requestEvaluation()`

흐름:

```text
source/vars/seed 변경
→ 기존 evaluation 취소
→ cached compiled source 확인
→ evaluate request 전송
→ scene snapshot 수신
→ Material resolution
→ document 상태를 Ready로 변경
```

revision이 바뀐 뒤 도착한 늦은 응답은 무시한다.

### 7.3 preflight `useEffect`

Structure와 Experiment가 모두 최신 revision으로 evaluate되면 자동으로 preflight를 시작한다.

preflight 요청에는 다음이 함께 전달된다.

- cached Experiment compiled source
- Structure의 `BuiltSample`
- Experiment의 `BuiltSetup`
- 두 document revision

결과는 UI에서 다음 상태로 보인다.

```text
unavailable → checking → compatible | incompatible
```

표시는 [`SolverSpecSheet.tsx`](../src/features/viewer/workspace/SolverSpecSheet.tsx)가 담당한다.

### 7.4 `run()`

Run 버튼이 호출하는 핵심 함수다.

실행 전 조건:

- Structure와 Experiment가 모두 `Ready`
- successful revision과 현재 revision이 같음
- preflight 결과가 `compatible`
- 다른 simulation이 실행 중이 아님

실행 중:

- `preparing` → `running`
- progress의 `task`와 `stage`를 UI에 반영
- source나 vars가 바뀌면 active run 취소

성공 시:

```ts
programResult = response.result
recordedData = result.recordedData에서 tensor만 추출한 값
```

`programResult`는 spec, trace, provenance까지 유지한다.
Viewer용 `recordedData`는 tensor 표시를 위해 더 단순한 형태로 만든다.

### 7.5 이 파일을 읽을 때 주의할 점

`useCadWorkspace`에는 서로 다른 세 생명주기가 같이 있다.

```text
document compile/evaluate
simulation preflight
simulation run/cancel/result
```

`useRef`는 늦게 도착한 Worker 응답에서 “현재 실행인지” 확인하는 용도로 많이 사용한다.
단순 React state 중복으로 생각하고 제거하면 stale response가 최신 결과를 덮어쓸 수 있다.

---

## 8. preflight는 무엇을 하고, 무엇을 하지 않는가

[`simulation/runtime.ts`](../src/lib/simulation/runtime.ts)의 `preflightSimulation()`을 읽는다.

preflight는 다음을 검사한다.

1. preview manifest와 재평가한 manifest가 같은가
2. 모든 task kernel이 catalog에 존재하는가
3. kernel identity가 일치하는가
4. task config가 descriptor에 맞는가
5. target group과 Material이 실제 scene에서 해석되는가
6. kernel `prepare()`가 성공하는가
7. 요청 output spec을 결정할 수 있는가

preflight가 하지 않는 것:

- 사용자 `simulate()` 실행
- loop 횟수 결정
- branch 실행
- 실제 kernel 간 artifact handoff 검사
- 수치 solver 실행

동적 handoff는 `simulate()`를 실제로 실행해야 알 수 있으므로 각 `sim.run()` 시점에 검사한다.

---

## 9. multiphysics의 중심: `runSimulationProgram`

이제 [`simulation/runtime.ts`](../src/lib/simulation/runtime.ts)의
`runSimulationProgram()`을 읽는다.

이 함수가 관리하는 저장소는 네 개다.

```ts
states: Map<revision, StateSnapshot>
artifacts: Map<artifactId, StoredArtifact>
stagedRecordedData: Map<recordedName, { spec, data }>
trace: SimulationTraceEntry[]
```

### 9.1 위조 불가능한 handle

`ArtifactRef`와 `StateRef`는 값 모양만 맞는다고 인정되지 않는다.

runtime은 생성한 object를 `WeakSet`에 등록하고 다음을 함께 검사한다.

- 같은 `runId`인가
- runtime이 실제로 만든 object인가
- 아직 저장소에 존재하는가
- artifact가 release되지 않았는가
- artifact type이 저장된 type과 같은가

따라서 사용자가 다음과 같이 비슷한 object를 만들어도 거부된다.

```ts
const fake = {
  runId: real.runId,
  id: real.id,
  artifactType: real.artifactType,
}
```

TypeScript brand는 작성 시 실수를 막고, `WeakSet`은 runtime 위조를 막는다.

### 9.2 `sim.run()`

한 번의 `sim.run()`은 다음 순서로 움직인다.

```text
task 확인
→ StateRef 확인
→ input port 이름/cardinality 확인
→ artifactType 확인
→ data schema와 unit/basis 정규화
→ prepare 결과 가져오기
→ kernel namespace state 복제
→ kernel execute
→ result 전체 검증
→ 새 state와 artifact를 한꺼번에 commit
→ trace 성공 기록
```

`running` flag가 이미 켜져 있으면 동시 `sim.run()`을 fatal error로 처리한다.

잘못된 예:

```ts
await Promise.all([sim.run(tasks.electric), sim.run(tasks.thermal)])
```

올바른 예:

```ts
const electric = await sim.run(tasks.electric)
const thermal = await sim.run(tasks.thermal, {
  state: electric.state,
  inputs: { heatSource: electric.artifacts.jouleHeating },
})
```

### 9.3 artifact input 검사

consumer input port는 먼저 semantic type을 검사한다.

```text
caemble.dc/total-current@1
```

semantic type이 맞은 다음에 dtype, quantity kind, unit, basis, axes를 검사한다.
호환 가능한 unit과 basis는 consumer 기준으로 변환한다.

즉, 단순히 데이터 배열 모양이 같다고 다른 물리량을 연결할 수 없다.

### 9.4 kernel 결과의 원자성

`execute()`가 반환했다고 바로 commit하지 않는다.

먼저 `assertKernelExecutionResult()`가 다음을 확인한다.

- 요청된 output key가 모두 존재하는가
- 요청하지 않은 output key가 없는가
- 각 artifact payload가 descriptor schema에 맞는가
- observation 이름과 scalar 타입이 맞는가
- state가 복제 가능한가

모든 검증이 끝난 다음 state revision과 artifacts를 저장소에 넣는다.
중간에 하나라도 실패하면 그 kernel invocation의 state와 artifacts는 commit되지 않는다.

앞선 kernel의 성공 artifact는 그대로 commit되어 있으므로 `simulate()`의 `catch`에서 fallback task를 실행할 수 있다.
다만 fatal contract violation은 runtime에 latch되므로 사용자 코드가 catch해도 성공으로 바꿀 수 없다.

### 9.5 state namespace와 branch

각 state revision은 kernel identity별 값을 가진 snapshot이다.

```text
State revision 4
├─ dc-current-density@0.0.0 → ...
└─ steady-state-heat@0.0.0 → ...
```

kernel은 자기 namespace의 state만 받는다.
다른 kernel의 opaque state를 물리 데이터 전달에 사용하지 않는다.

이전 `StateRef`를 다시 넘기면 branch가 된다.

```ts
const base = sim.initialState
const left = await sim.run(tasks.a, { state: base })
const right = await sim.run(tasks.a, { state: base })
```

kernel 결과에서 `state`를 생략하면 state가 바뀌지 않은 것으로 간주하고 입력 `StateRef`를 그대로 반환한다.
현재 계약상 namespace state를 실제 `undefined` 값으로 갱신할 수는 없으므로 reset이 필요하면 `null`이나 명시적인 object 상태를 사용해야 한다.

### 9.6 `sim.record()`

`sim.record(name, artifact)`는 다음을 검사한다.

- Experiment에 선언된 RecordedData 이름인가
- 같은 이름을 이미 기록하지 않았는가
- artifact가 유효하고 release되지 않았는가
- artifact schema를 최종 RecordedData schema로 변환할 수 있는가

성공한 데이터는 즉시 Viewer에 공개되지 않고 `stagedRecordedData`에 들어간다.

record 후 원본 artifact를 release해도 된다.
staging에는 정규화된 최종 tensor가 별도로 보존되어 있다.

### 9.7 전체 simulation 원자성

`simulate()`가 끝난 뒤에도 다음을 검사한다.

- 아직 await하지 않은 `sim.run()`이 없는가
- 반환한 final `StateRef`가 유효한가
- 선언한 모든 RecordedData key를 정확히 한 번 기록했는가
- 취소 또는 fatal error가 발생하지 않았는가

실패하면 staged RecordedData 전체를 비운다.
성공한 경우에만 `SimulationResult`를 만든다.

---

## 10. 표준 kernel 계약 읽기

새 kernel의 공통 타입은
[`kernelContract/types.ts`](../src/lib/simulation/kernelContract/types.ts)에 있다.

```ts
type KernelDefinition<Prepared> = {
  descriptor: KernelDescriptor
  prepare: (context) => KernelPrepareResult<Prepared>
  execute: (input, context) => Promise<KernelExecutionResult>
}
```

각 책임은 다음과 같다.

### 10.1 descriptor

kernel의 공개 계약을 유일하게 소유한다.

- name/version/reference unit
- global parameters
- Material 역할과 property
- input ports
- observations
- initialization methods
- boundary condition methods
- output methods와 artifact schema

descriptor를 바꾸면 runtime validation과 Monaco declaration 생성에 함께 반영된다.

### 10.2 prepare

문자열과 authoring descriptor를 solver가 바로 사용할 semantic input으로 바꾼다.

```text
target 문자열
→ 실제 CAD part/surface

Material descriptor
→ canonical 물성값

parameter와 unit
→ solver 기준 숫자
```

`prepare()`에는 수치해석 자체를 넣지 않는 것이 좋다.
preflight에서도 prepare를 호출하고, 실제 Run은 새 disposable Worker에서 다시 prepare하기 때문이다.

### 10.3 execute

오직 다음에 집중한다.

- prepared input 사용
- input artifact payload 사용
- numerical solve
- cancellation 확인
- progress 보고
- 요청된 artifact와 observations 반환

target 문자열이나 Material schema를 다시 해석하지 않는다.

### 10.4 공통 validation

[`kernelContract/validation.ts`](../src/lib/simulation/kernelContract/validation.ts)는 다음 세 시점의 공통 검증을 모은다.

```text
descriptor 자체 검증
task config 검증과 정규화
execute result 검증
```

이 파일은 길지만 처음에는 다음 함수만 순서대로 읽으면 된다.

1. `validateKernelDescriptor()`
2. `normalizeKernelTaskConfig()`
3. `resolveKernelOutputSpecs()`
4. `resolveKernelInputPort()`
5. `assertKernelExecutionResult()`

---

## 11. DC kernel을 실제로 따라가기

DC kernel은 다음 폴더에 있다.

```text
src/lib/simulation/kernels/dcCurrentDensity/
├─ descriptor.ts
├─ prepare.ts
├─ execute.ts
├─ numeric.ts
├─ index.ts
└─ contract.test.ts
```

### 11.1 `descriptor.ts`

먼저 method 목록을 확인한다.

| category       | methodId                 |     횟수 |
| -------------- | ------------------------ | -------: |
| initialization | `dc.voxel-grid`          | 정확히 1 |
| boundary       | `dc.source-potential`    | 정확히 1 |
| boundary       | `dc.reference-potential` | 정확히 1 |
| output         | `dc.current-density`     |   0 이상 |
| output         | `dc.total-current`       |   0 이상 |
| output         | `dc.joule-heating`       | 최대 1회 |

전체 output 요청은 최소 한 개다.

output artifact:

```text
dc.current-density → caemble.dc/current-density@1
dc.total-current   → caemble.dc/total-current@1
dc.joule-heating   → caemble.dc/joule-heating@1
```

DC input port는 현재 비어 있다.
observations는 `iterations`, `relativeResidual` 두 숫자다.

파일 마지막의 `DcArtifactTypes` mapped type도 확인한다.
task의 `outputs[].key`와 `methodId`를 읽어 authoring 코드의 artifact key/type을 추론한다.

### 11.2 `prepare.ts`

`prepareDcCurrentDensity()`의 흐름:

```text
공통 task config 정규화
→ conductor geometry group 해석
→ source/reference surface group 해석
→ 두 terminal이 같은 conductor에 속하는지 확인
→ Structure lengthUnit을 m로 변환
→ conductivity tensor를 S/m identity basis로 변환
→ isotropic/positive conductivity 확인
→ grid와 voltage, tolerance, output 요청 추출
→ PreparedDcInput 생성
```

이 단계가 끝나면 수치 solver는 `structure.geometry.conductor` 같은 문자열을 알 필요가 없다.

### 11.3 `execute.ts`

`executeDcCurrentDensity()`는 얇은 adapter다.

- `numeric.ts` 호출
- 취소, 수렴, 입력, backend, resource 오류 분류
- `SimulationKernelError`로 변환

수치 코드를 오류 계약과 분리하기 위한 경계다.

### 11.4 `numeric.ts`

수치 흐름은 `solvePreparedDcCurrentDensity()`부터 읽는다.

```text
terminal 평면과 local frame 계산
→ voxel occupancy 생성
→ conductor connectivity 확인
→ 선형 시스템 구성
→ PCG로 potential 계산
→ 요청된 cross-section 계산
→ 요청된 output artifact만 생성
→ iterations와 relativeResidual 반환
```

progress stage:

```text
occupancy
connectivity
solve
output
```

potential field는 task invocation당 한 번만 계산한다.
같은 cross-section 위치의 여러 output은 계산 결과를 재사용한다.
`dc.current-density`가 요청되지 않은 위치에서는 불필요한 density tensor를 만들지 않는다.

### 11.5 `index.ts`

마지막에 읽는다.

이 파일은 두 세계를 연결한다.

```text
dcCurrentDensity(config)
→ Experiment Source가 사용하는 task builder

dcCurrentDensityKernel
→ runtime registry가 사용하는 descriptor/prepare/execute 묶음
```

production catalog는 [`kernels/index.ts`](../src/lib/simulation/kernels/index.ts)에 있고 DC와 Heat entry를 함께 등록한다.

### 11.6 Heat kernel

[`steadyStateHeat/`](../src/lib/simulation/kernels/steadyStateHeat/)는 같은 terminal-aligned voxel domain을 사용한다.

```text
heat.voxel-grid          → 정확히 1회
heat.fixed-temperature   → 정확히 2회
heat.temperature         → caemble.heat/temperature@1
heat.maximum-temperature → caemble.heat/maximum-temperature@1
```

선택적 `heatSource` input은 `caemble.dc/joule-heating@1`을 받고 grid shape와 axis tick을 검사한다.
`thermal.conductivity`를 SI 단위로 정규화한 뒤 `-∇·(k∇T)=q`를 풀며, 다른 외곽면은 단열이다.
공통 좌표계, occupancy/connectivity, scalar PCG는 `voxelFiniteVolume.ts`에 있고 physics별 output 계산은 각 kernel에 남는다.

---

## 12. 결과는 어떻게 Viewer와 Measurement로 가는가

### 12.1 `SimulationResult`

[`simulation/types.ts`](../src/lib/simulation/types.ts)의 `SimulationResult`를 먼저 본다.

```ts
type SimulationResult = {
  format: 'caemble-run'
  formatVersion: 1
  runId: string
  finalStateRevision: number
  recordedData: Record<string, { spec; data }>
  trace: SimulationTraceEntry[]
  provenance: SimulationProvenance
}
```

포함되지 않는 것:

- intermediate ArtifactRef
- intermediate artifact tensor
- kernel 내부 opaque state

### 12.2 Viewer

흐름:

```text
useCadWorkspace
→ result.recordedData에서 tensor 추출
→ CadViewer
→ RecordedDataResults
```

관련 파일:

1. [`CadViewer.tsx`](../src/features/viewer/viewer/CadViewer.tsx)
2. [`recordedData.ts`](../src/features/viewer/viewer/recordedData.ts)
3. [`RecordedDataResults.tsx`](../src/features/viewer/viewer/RecordedDataResults.tsx)

Viewer rule은 Experiment manifest의 global RecordedData schema에서 만든다.
task output descriptor를 일반 결과 목록으로 직접 노출하지 않는다.

### 12.3 Measurement 저장

[`MeasurementPage.tsx`](../src/pages/measurements/MeasurementPage.tsx)에서
simulation 성공 후 `MeasurementSaveRequest`를 만든다.

```ts
recorded_data: Object.entries(result.recordedData).map(([name, entry]) => ({
  name,
  quantity_kind: entry.spec.quantityKind ?? 'Dimensionless',
  tensor_order: ...,
  dtype: entry.spec.dtype,
  data: entry.data,
}))
```

global RecordedData key 하나가 기존 DB의 RecordedData 행 하나가 된다.

중요한 저장 경계:

- backend/API/DB shape는 변경하지 않는다.
- 전체 `SimulationResult`는 저장하지 않는다.
- trace와 provenance는 저장하지 않는다.
- intermediate artifact는 저장하지 않는다.
- 저장되는 tensor는 이미 `sim.record()`에서 최종 schema로 정규화된 값이다.

---

## 13. 오류를 따라 읽는 방법

오류를 보면 어느 층에서 발생했는지 먼저 구분한다.

| 오류 예                        | 발생 층                  | 먼저 볼 파일                             |
| ------------------------------ | ------------------------ | ---------------------------------------- |
| 허용되지 않은 import           | source policy            | `sourceAnalysis.ts`                      |
| TypeScript 타입 오류           | compiler                 | `monacoCompiler.ts`                      |
| geometry/material 해석 실패    | evaluate/prepare         | `userModule.ts`, kernel `prepare.ts`     |
| unknown methodId               | kernel contract          | `kernelContract/validation.ts`           |
| incompatible artifact type     | simulation handoff       | `simulation/runtime.ts`                  |
| output key 누락/초과           | kernel result validation | `kernelContract/validation.ts`           |
| PCG 미수렴                     | DC execute/numeric       | `execute.ts`, `numeric.ts`               |
| duplicate/missing RecordedData | simulation finalization  | `simulation/runtime.ts`                  |
| 늦은 Worker 결과가 보임        | frontend lifecycle       | `useCadWorkspace.ts`, `runner/client.ts` |
| Measurement 저장 실패          | persistence UI/API       | `MeasurementPage.tsx`                    |

`SimulationKernelError`와 `SimulationFatalError`의 차이도 중요하다.

- kernel error는 `simulate()`가 catch하고 명시적인 fallback branch를 실행할 수 있다.
- fatal error는 계약 위반이므로 catch해도 runtime에 latch되어 전체 simulation이 실패한다.

---

## 14. 테스트를 사양서처럼 읽는 순서

구현을 이해할 때 테스트가 가장 빠른 사양서 역할을 한다.

### 14.1 runtime 계약

[`simulation/runtime.test.ts`](../src/lib/simulation/runtime.test.ts)를 다음 테스트 이름 순서로 읽는다.

1. typed artifact 교환, unit 변환, observation loop
2. RecordedData unit/basis 변환
3. schema mismatch
4. namespaced state와 rollback
5. structured-cloneable opaque state
6. use-after-release
7. required/unknown/wrong-type input
8. foreign-run/forged ref/concurrent run
9. undeclared/duplicate/missing RecordedData
10. 뒤 kernel 실패 시 staged RecordedData 폐기
11. 같은 local output key의 task 간 격리

mock kernel A/B는 production catalog kernel이 아니다.
테스트 registry에만 주입되어 multiphysics runtime 계약을 검증한다.

### 14.2 kernel 공통 계약

- [`kernelContract/validation.test.ts`](../src/lib/simulation/kernelContract/validation.test.ts)
- [`kernelContract/conformance.test.ts`](../src/lib/simulation/kernelContract/conformance.test.ts)

descriptor, output payload, observation, cancellation, progress 계약을 확인한다.

### 14.3 DC kernel

- [`dcCurrentDensity/contract.test.ts`](../src/lib/simulation/kernels/dcCurrentDensity/contract.test.ts)

다중 cross-section, 요청 output만 생성, cancellation, 약 14.9 A golden parity를 확인한다.

### 14.4 frontend lifecycle

- [`useCadWorkspace.test.tsx`](../src/features/viewer/workspace/useCadWorkspace.test.tsx)
- [`runner/protocol.test.ts`](../src/lib/cad/runner/protocol.test.ts)
- [`runner/evaluation.worker.test.ts`](../src/lib/cad/runner/evaluation.worker.test.ts)

compile cache, reroll, stale response, progress, cancel과 protocol validation을 확인한다.

---

## 15. 코드 리뷰 결과

### 15.1 잘 분리된 부분

1. **descriptor가 kernel 계약의 단일 원천이다.**
   runtime validation, catalog, generated declaration이 같은 descriptor를 사용한다.

2. **authoring과 numerical code가 직접 결합되지 않았다.**
   `prepare()`가 문자열 target, Material, unit을 semantic input으로 바꾼 뒤 `execute()`에 넘긴다.

3. **artifact와 RecordedData의 의미가 분리되어 있다.**
   multiphysics 중간값이 실수로 Measurement 결과가 되는 것을 막는다.

4. **kernel 결과 commit이 원자적이다.**
   state나 일부 artifact만 남는 부분 성공 상태를 방지한다.

5. **동적 orchestration을 일반 JavaScript에 남겼다.**
   별도 workflow DSL이나 숨은 실행 순서 없이 loop, branch, fallback을 표현한다.

6. **Worker 경계가 명확하다.**
   대형 intermediate tensor가 UI main thread나 persistence layer로 나오지 않는다.

7. **frontend stale-response 방어가 구체적이다.**
   nonce, requestId, revision을 protocol과 hook 양쪽에서 확인한다.

### 15.2 앞으로 수정할 때 특히 조심할 지점

1. **`useCadWorkspace.ts`는 현재 가장 큰 frontend 복잡도 지점이다.**
   document evaluation, preflight, run lifecycle을 동시에 관리한다.
   기능이 더 늘어나면 세 lifecycle별 hook 분리를 검토할 수 있지만, stale-response 검사를 훼손하지 않도록 현재 테스트를 먼저 고정해야 한다.

2. **`runtime.ts`는 의도적으로 중앙집중적이다.**
   파일은 길지만 atomic commit과 fatal latch를 한곳에서 보기 쉽다는 장점이 있다.
   저장소를 분리한다면 state/artifact/RecordedData 사이의 commit 순서를 바꾸지 않아야 한다.

3. **`prepare()`는 preflight와 Run에서 각각 호출된다.**
   두 실행은 서로 다른 disposable Worker다.
   미래 kernel의 prepare에 무거운 iterative solve나 대형 임시 tensor 생성을 넣으면 preflight 비용이 커진다.

4. **취소는 kernel의 협조가 필요하다.**
   전체 계산 timeout이 없으므로 긴 loop에서는 `AbortSignal`을 확인하고 Worker event loop에 제어를 돌려줘야 한다.
   DC `numeric.ts`의 `throwIfAborted()`와 `yieldToWorker()`가 참고 구현이다.

5. **`state: undefined`는 “변경 없음”이라는 신호다.**
   실제 state reset 값이 필요하면 `null` 또는 명시적인 state object를 사용해야 한다.

6. **Measurement에는 전체 실행 provenance가 저장되지 않는다.**
   이는 현재 명시적인 제품 경계다.
   향후 재현성 요구가 바뀌면 frontend만 수정해서는 안 되고 backend 저장 계약을 별도로 설계해야 한다.

7. **`programHash`는 현재 compiled source의 `sourceHash`를 사용한다.**
   preview와 Run의 정확한 source revision을 묶는 용도다.
   이름만 보고 전체 Structure/Material/kernel binary의 content hash라고 해석하면 안 된다.

### 15.3 현재 구조에서 새 kernel을 추가할 때

runtime이나 Experiment API를 수정하는 것이 아니라 다음 순서로 작업한다.

```text
1. kernels/<newKernel>/descriptor.ts
2. prepare.ts
3. execute.ts
4. index.ts
5. contract.test.ts
6. kernels/index.ts production catalog entry
7. npm run generate:cad-api
```

복사 가능한 골격과 체크리스트는
[`kernelContract/README.md`](../src/lib/simulation/kernelContract/README.md)에 있다.

---

## 16. 추천 정독 일정

### 1회차: 실행 개념 잡기

- `defaultExperimentProgramCode.ts`
- `model/v3.ts`
- 이 문서의 1~4절

목표: task, artifact, observation, RecordedData의 차이를 설명할 수 있어야 한다.

### 2회차: 프론트엔드 흐름 잡기

- `monacoCompiler.ts`
- `useCadWorkspace.ts`
- `runner/client.ts`
- `runner/evaluation.worker.ts`

목표: Run 버튼을 눌렀을 때 어떤 request가 어디로 가는지 설명할 수 있어야 한다.

### 3회차: multiphysics runtime 이해하기

- `simulation/types.ts`
- `simulation/runtime.ts`
- `simulation/runtime.test.ts`

목표: 두 kernel이 artifact와 StateRef를 교환할 때 runtime이 무엇을 검증하는지 설명할 수 있어야 한다.

### 4회차: DC kernel 이해하기

- `descriptor.ts`
- `prepare.ts`
- `execute.ts`
- `numeric.ts`
- `contract.test.ts`

목표: authoring의 `dc.total-current` 요청이 실제 scalar artifact가 되는 과정을 설명할 수 있어야 한다.

### 5회차: 결과 저장까지 닫기

- `CadViewer.tsx`
- `RecordedDataResults.tsx`
- `MeasurementPage.tsx`

목표: intermediate artifact가 DB에 저장되지 않는 이유와 최종 RecordedData 행 변환을 설명할 수 있어야 한다.

---

## 17. 직접 디버깅해 보는 연습

다음 변경을 한 번에 하나씩 적용하고 오류가 어느 층에서 잡히는지 확인하면 이해가 빠르다.

1. `methodId`를 `dc.unknown`으로 바꾼다.
   - 예상: preflight의 task config validation 실패

2. `dc.total-current`의 target group 이름을 틀리게 바꾼다.
   - 예상: target resolution 또는 DC prepare 실패

3. `sim.record('unknown', ...)`을 호출한다.
   - 예상: runtime fatal error

4. 같은 RecordedData 이름을 두 번 record한다.
   - 예상: duplicate RecordedData fatal error

5. `currentDensity`를 release한 뒤 record한다.
   - 예상: use-after-release fatal error

6. `sim.run()`에서 `await`를 제거한다.
   - 예상: simulate 종료 시 unawaited run fatal error

7. DC output에서 `currentDensity` 요청을 제거한다.
   - 예상: potential solve와 total current만 수행되고 density tensor는 생성되지 않음

연습 후에는 원래 source로 되돌리고 다음 검증을 순서대로 실행한다.

```powershell
npm run generate:cad-api
npm run check:generated
npm test
npm run lint
npm run format:check
npm run build
npm run test:e2e
git diff --check
```

Vite 관련 임시 파일 충돌을 피하기 위해 검증 명령은 병렬이 아니라 순차로 실행한다.
