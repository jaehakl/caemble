# Multiphysics Experiment Program

이 문서는 버전 경로가 없는 CAD authoring과 Python CAE slave 실행 계약을 설명한다.

Structure는 TSX Source 하나로 작성하고, Experiment는 선언 TSX와 Python `simulate.py`를 함께 저장한다.

```text
Structure Source + Experiment Source
→ Source별 1회 compile/evaluate
→ DataSchema와 task별 kernel descriptor 정규화
→ WebRTC를 통한 CAE slave 요청
→ Python simulate()의 순차 제어와 typed artifact 교환
→ await sim.record() 단위 결과/ACK
→ Experiment RecordedData 확정
→ Measurement 저장
```

공개 import는 두 개뿐이다.

```ts
import { experiment, structure } from "@caemble/core";
import { dcCurrentDensity } from "@caemble/kernels";
```

상대 경로, 동적 import, `require()`, 버전 경로가 붙은 package import는 지원하지 않는다.

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

## Experiment Source

```tsx
import { experiment, type Geometry } from "@caemble/core";
import { dcCurrentDensity } from "@caemble/kernels";

const Probe: Geometry = () => <box size={[1, 1, 1]} />;

export default experiment({
  lengthUnit: "mm",
  varsSchema: {
    sourceVoltage: { min: 1, max: 1 },
  },
  geometry: () => <Probe id="probe" />,

  tasks: ({ vars }) => ({
    electric: dcCurrentDensity({
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
          parameters: {
            crossSectionPosition: {
              dtype: "float64",
              value: 0.5,
              unit: "{fraction}",
              quantityKind: "DimensionlessRatio",
            },
          },
        },
        {
          key: "totalCurrent",
          methodId: "dc.total-current",
          target: ["structure.geometry.conductor"],
          parameters: {
            crossSectionPosition: {
              dtype: "float64",
              value: 0.5,
              unit: "{fraction}",
              quantityKind: "DimensionlessRatio",
            },
          },
        },
      ],
    }),
  }),

  recordedData: {
    measuredCurrent: {
      dtype: "float64",
      unit: "A",
      quantityKind: "electromagnetism.ElectricCurrent",
    },
  },
});
```

## Python simulate.py

```python
async def simulate(*, sim, tasks, vars, world):
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

여러 physics kernel도 같은 `tasks` object에 선언한다. 연결 순서와 전달할 artifact는 Python `simulate()`가 직접 결정한다.

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
- 호환 가능한 unit과 basis는 consumer 또는 RecordedData schema로 정규화한다.
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

모든 kernel은 다음 구조와 공통 contract test를 사용한다.

```text
kernels/<kernel>/
├─ descriptor
├─ prepare
├─ execute
├─ index
└─ contract tests
```

descriptor가 identity, parameters, Material 역할, input ports, observations,
initialization/boundary/output method와 output artifact schema를 유일하게 소유한다.
`npm run generate:cad-api`는 production descriptor를 읽어 Monaco의
`@caemble/kernels` 선언과 declaration fingerprint를 생성한다.

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
