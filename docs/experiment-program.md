# Multiphysics Experiment Program

이 문서는 버전 경로가 없는 CAD authoring과 Python CAE slave 실행 계약을 설명한다.

Structure는 TSX Source 하나로 작성한다. Experiment는 `experiment.tsx`, `simulate.py`, 하나 이상의
`tasks/*.tsx`를 `{ formatVersion: 1, files }` JSON bundle 하나로 원자적으로 저장한다.

```text
Structure Source + Experiment source bundle
→ 공통 vars 1회 resolve, TSX 파일별 compile/evaluate
→ Task별 scene/config/material snapshot 생성
→ 작성 단위를 보존한 raw sample/setup 직렬화
→ WebRTC를 통한 CAE slave 요청
→ CAE manifest 기준 검증과 UCUM 단위 변환
→ Python simulate()의 순차 제어와 typed artifact 교환
→ await sim.record() 단위 결과/ACK
→ Experiment RecordedData 확정
→ Measurement 저장
```

공개 import는 하나뿐이다.

각 TSX 파일의 공개 import는 `@caemble/core` 하나뿐이다. 상대 import, Task 간 import,
동적 import, `require()`, 버전 경로가 붙은 package import는 지원하지 않는다.

## 역할 구분

- `task.outputs`: kernel이 계산해야 하는 중간 artifact 요청
- `result["artifacts"]`: 다음 kernel이나 `sim.record()`에 전달하는 opaque handle
- `result.observations`: loop 종료와 branch 판단에 쓰는 작은 scalar 값
- Experiment `recordedData`: Measurement에 최종 저장할 데이터 계약
- `await sim.record(name, artifact)`: 중간 artifact를 RecordedData로 승격하고 브라우저 ACK까지 backpressure
- `sim.release(artifact)`: 더 이상 쓰지 않는 중간 artifact 해제
- `StateRef`: kernel별 opaque 내부 상태 revision. 물리 데이터 전달에는 사용하지 않는다.

중간 artifact는 기록하지 않으면 Viewer 결과와 Measurement payload에 포함되지 않는다.

## Structure Source

```tsx
import {
  Mat,
  Material,
  structure,
  type Geometry,
  type Vec3,
} from "@caemble/core";

const Conductor: Geometry<{ size: Vec3 }> = ({ size }) => <box size={size} />;

export default structure({
  lengthUnit: "mm",
  varsSchema: {
    size: { min: [100, 10, 10], max: [100, 10, 10] },
    conductivity: { min: 5.96e7, max: 5.96e7 },
  },
  geometry: ({ vars }) => (
    <Conductor
      id="conductor"
      size={vars.size}
      materials={[
        new Material("Copper", "reference", {
          "electrical.conductivity": {
            dtype: "float64",
            value: Mat(vars.conductivity),
            unit: "S.m-1",
          },
        }),
      ]}
    />
  ),
  geometryGroup: {
    conductor: ["conductor"],
  },
  surfaceGroup: {
    sourceTerminal: ["conductor/surface-1"],
    referenceTerminal: ["conductor/surface-2"],
  },
});
```

## 공통 Experiment Source (`experiment.tsx`)

```tsx
import { experiment } from "@caemble/core";

export default experiment({
  varsSchema: {
    sourceVoltage: { min: 1, max: 1 },
  },
  recordedData: {
    measuredCurrent: {
      dtype: "float64",
      unit: "A",
      quantityKind: "electromagnetism.ElectricCurrent",
    },
  },
});
```

## Task Source (`tasks/electric.tsx`)

Task 이름 `electric`은 파일명에서 등록된다. `geometry`를 사용하지 않는 Task도
`geometry: () => null`과 `lengthUnit`을 반드시 선언한다.

```tsx
import { defineTask } from "@caemble/core";

function Probe() {
  return <box size={[1, 1, 1]} />;
}

export default defineTask({
  kernel: { name: "dc-current-density", version: "0.0.0" },
  lengthUnit: "mm",
  geometry: () => <Probe id="probe" />,
  geometryGroup: { probe: ["probe"] },
  config: ({ vars }) => ({
    parameters: {
      relativeTolerance: {
        dtype: "float64",
        value: 1e-8,
        unit: "{fraction}",
        quantityKind: "DimensionlessRatio",
      },
      maxIterations: 2000,
    },
    initializations: [
      {
        methodId: "dc.voxel-grid",
        target: ["structure.geometry.conductor"],
        parameters: {
          gridShape: {
            dtype: "int32",
            axes: [{ length: 3 }],
            value: [100, 41, 41],
          },
        },
      },
    ],
    boundaryConditions: [
      {
        methodId: "dc.source-potential",
        target: ["structure.surface.sourceTerminal"],
        parameters: {
          voltage: {
            dtype: "float64",
            value: vars.sourceVoltage,
            unit: "mV",
            quantityKind: "electromagnetism.Voltage",
          },
        },
      },
      {
        methodId: "dc.reference-potential",
        target: ["structure.surface.referenceTerminal"],
        parameters: {
          voltage: {
            dtype: "float64",
            value: 0,
            unit: "mV",
            quantityKind: "electromagnetism.Voltage",
          },
        },
      },
    ],
    outputs: [
      {
        key: "currentDensity",
        methodId: "dc.current-density",
        target: ["structure.geometry.conductor"],
        parameters: {},
      },
      {
        key: "totalCurrent",
        methodId: "dc.total-current",
        target: ["structure.geometry.conductor"],
        parameters: {},
      },
    ],
  }),
});
```

## Python simulate.py

```python
async def simulate(*, sim, tasks, vars):
    electric = await sim.run(tasks["electric"])
    await sim.record(
        "measuredCurrent",
        electric["artifacts"]["totalCurrent"],
    )
    sim.release(electric["artifacts"]["currentDensity"])
    return electric["state"]
```

허용되는 simulation API는 `sim.run`, `sim.record`, `sim.release`, `sim.random`뿐이다.
Python source는 import, 파일·네트워크 접근, `eval` 계열을 허용하지 않는 AST 정책을 통과해야 한다.

## Multiphysics orchestration

여러 physics kernel은 각각 독립된 `tasks/<taskName>.tsx` 파일로 선언한다. 연결 순서와 전달할
artifact는 Python `simulate()`가 직접 결정한다. `experiment.*` target은 현재 실행 중인 Task scene만 가리킨다.

```python
electric = await sim.run(tasks["electric"])
thermal = await sim.run(
    tasks["thermal"],
    state=electric["state"],
    inputs={"heatSource": electric["artifacts"]["jouleHeating"]},
)

await sim.record("totalCurrent", electric["artifacts"]["totalCurrent"])
await sim.record("temperature", thermal["artifacts"]["temperature"])
await sim.record("maximumTemperature", thermal["artifacts"]["maximumTemperature"])
sim.release(electric["artifacts"]["jouleHeating"])
return thermal["state"]
```

production catalog에는 `dc-current-density@0.0.0`과 `steady-state-heat@0.0.0`이 등록되어 있다.

## 실행 규칙

- `sim.run()`은 한 번에 하나만 실행할 수 있고, 브라우저는 `next` call을 하나만 outstanding 상태로 둔다.
- `inputs`의 artifactType과 consumer port의 artifactType이 먼저 일치해야 한다.
- unit, basis, dtype와 QuantityKind는 UI build 단계에서 descriptor 기준으로
  정규화하며 CAE는 받은 canonical 값을 다시 추론하거나 보완하지 않는다.
- release한 artifact를 다시 전달하거나 기록하면 실행 전체가 실패한다.
- kernel output key 누락·초과, payload schema 오류, observation 오류가 있으면 해당 kernel의 state와 artifact를 함께 rollback한다.
- Experiment `recordedData`의 모든 key는 성공 실행에서 정확히 한 번 기록해야 한다.
- undeclared, duplicate, missing RecordedData는 fatal error다.
- 뒤 task나 `simulate()`가 실패하면 이미 받은 provisional RecordedData 전체를 폐기한다.
- time-series는 반복 `record()` 대신 시간축을 가진 하나의 tensor artifact로 기록한다.

## DC kernel

DC task는 다음 method를 지원한다.

| Category           | methodId                 | Occurrence |
| ------------------ | ------------------------ | ---------: |
| initialization     | `dc.voxel-grid`          |   정확히 1 |
| boundary condition | `dc.source-potential`    |   정확히 1 |
| boundary condition | `dc.reference-potential` |   정확히 1 |
| output             | `dc.current-density`     |     0 이상 |
| output             | `dc.total-current`       |     0 이상 |
| output             | `dc.joule-heating`       |   최대 1회 |

전체 output 요청은 한 개 이상이어야 한다. 실행 결과의 observations는
`iterations: number`, `relativeResidual: number`이며 DC input port는 비어 있다.

## Heat kernel

정상상태 Heat task는 다음 method를 지원한다.

| Category           | methodId                   | Occurrence |
| ------------------ | -------------------------- | ---------: |
| initialization     | `heat.voxel-grid`          |   정확히 1 |
| boundary condition | `heat.fixed-temperature`   |   정확히 2 |
| output             | `heat.temperature`         |   최대 1회 |
| output             | `heat.maximum-temperature` |   최대 1회 |

`heatSource` input port는 선택적으로 `caemble.dc/joule-heating@1` artifact 하나를 받는다.
두 고정온도 끝면 사이에서 `-∇·(k∇T)=q`를 풀며 나머지 외곽면은 단열이다.
Material에는 양의 등방성 `thermal.conductivity`가 필요하고, observations는 DC와 동일하게
`iterations`, `relativeResidual`을 반환한다.

## 새 kernel 추가

Caemble의 `app/slaves/cae/app/solvers/<solver_name>/`에 `manifest.json`,
`solver.py`, 전용 테스트를 추가한다. CAE registry는 manifest를 자동 발견하며 중앙 등록
코드를 수정하지 않는다. UI에는 manifest 사본이나 solver별 TypeScript 선언을 만들지
않는다. Solver Catalog는 같은 manifest를 Vite build 시 직접 포함하므로 변경 후 UI를
다시 빌드한다. 외부 SDK 호환을 위한 `cae.solvers.manifests` handler는 그대로 유지한다.

UI example에는 공통 `experiment.tsx`, `simulate.py`, 독립 `tasks/*.tsx` bundle을 추가하고 raw
fixture를 재생성해 UI-CAE 계약 테스트를 실행한다.

## 검증

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

Vite 기반 검증은 순차 실행한다.
