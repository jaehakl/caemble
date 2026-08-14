# Multiphysics Experiment Program

이 문서는 통합 Experiment authoring, Measurement 준비, CAE 실행 계약을 설명한다.

하나의 Experiment revision은 다음 source bundle을 원자적으로 소유한다.

```text
{
  formatVersion: 5,
  files: {
    "experiment.tsx": string,
    "geometry.tsx": string,
    "material.tsx": string,
    "simulate.py": string,
    "tasks/<taskName>.tsx": string,
    ...
  },
  geometrySnapshot: { schemaVersion: 2, entryImports: [...], modules: [...] }
}
```

`experiment.tsx`, `geometry.tsx`, `material.tsx`, `simulate.py`, 하나 이상의 Task 파일이 필수다. CAD document format은 2,
CAD authoring API는 6, Geometry module format은 4, Simulation manifest는 5, Python simulation API는 3이다. 구형
Structure document와 `{ sample, setup }` 실행 payload는 받지 않는다.

```text
Experiment revision + complete vars
→ 공통 scene과 Task-local scenes 결정론적 평가
→ 모든 scene의 같은 Material 선언을 Candidate 전체에서 한 번 생성해 동결
→ prepared Measurement 저장
→ 원하는 시점에 BuiltMeasurement를 CAE slave로 실행
→ 성공한 RecordedData 전체를 한 번에 부착
→ recorded Measurement
```

Measurement 생성과 solver 실행은 별개다. 실패하거나 취소된 실행은 prepared Measurement를
변경하지 않는다. 이미 recorded인 Measurement는 다시 실행하지 않으며 같은 조건을 다시
실행하려면 Measurement를 복제한다.

## 공개 import와 결정론

`geometry.tsx`와 Published Geometry source는 `@caemble/core`와 exact
`caemble:geometry/<namespace>/<repository>/<package>@X.Y.Z` named import만 사용한다.
`material.tsx`는 `@caemble/core`만 정적으로 import한다. `experiment.tsx`는 `./geometry`와
`./material`, Task는 `../geometry`와 `../material`에서 named export를 가져온다. Task 간 import,
동적 import, `require()`, 그 밖의 package import는 지원하지 않는다.
`Math.random`, `Date`, `crypto` 같은 숨은 비결정성도 authoring source에서 금지한다.

평가기는 `varsSchema`의 모든 key가 포함된 vars만 받는다. 누락·초과 key, 잘못된 tensor
shape, 비유한 값, 범위 밖 값은 geometry나 config callback을 실행하기 전에 거부한다. Candidate 생성은
스키마 범위에서 새 candidate와 frozen Material 값을 만들 뿐 source를 변경하거나 저장·실행하지
않는다. `min === max`인 항목은 고정값이다. seed와 생성 provenance는 저장하지 않는다.

## 공통 Geometry Source (`geometry.tsx`)

`geometry.tsx`는 Experiment와 모든 Task가 공유할 named Geometry component를 여러 개 export한다.
Published Geometry를 사용할 때도 이 파일의 exact import가 그래프의 유일한 시작점이다.

```tsx
import { type Geometry, type Vec3 } from "@caemble/core";

export const Conductor: Geometry<{ size: Vec3 }> = ({ size }) => <box size={size} />;

export const Probe: Geometry = () => <box size={[2, 2, 2]} />;

const TireLeaf: Geometry = () => <cylinder radius={20} height={8} />;
const HubLeaf: Geometry = () => <cylinder radius={8} height={8} />;

export const WheelParts: Geometry = ({ materials }) => (
  <union>
    <TireLeaf id="tire" materials={{ body: materials?.tire }} />
    <HubLeaf id="hub" materials={{ body: materials?.wheel }} />
  </union>
);
```

Geometry의 `materials`는 배열이 아니라 역할 이름을 key로 쓰는 map이다. primitive는 `body` 역할을
암묵적으로 소비한다. child에서 `materials`를 생략하면 현재 map 전체를 상속하고, 명시하면 map을
교체하며 `{}`는 상속을 지운다. 중간 component는 역할을 바꾸어 전달할 수 있다.

## 공통 Experiment Source (`experiment.tsx`)

`experiment.tsx`가 공통 length unit, vars, physical geometry, groups, 최종 RecordedData
계약을 함께 소유한다.

```tsx
import { experiment } from "@caemble/core";
import { Conductor } from "./geometry";
import { Copper } from "./material";

export default experiment({
  lengthUnit: "mm",
  varsSchema: {
    size: { min: [80, 8, 8], max: [120, 12, 12] },
    conductivity: { min: 5.8e7, max: 6.1e7 },
    sourceVoltage: { min: 0.5, max: 1.5 },
  },
  geometry: ({ vars }) => (
    <Conductor
      id="conductor"
      size={vars.size}
      materials={{ body: Copper(vars.conductivity as number) }}
    />
  ),
  geometryGroup: {
    conductor: ["conductor"],
  },
  surfaceGroup: {
    sourceTerminal: ["conductor/surface-1"],
    referenceTerminal: ["conductor/surface-2"],
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

## 공통 Material Source (`material.tsx`)

Material은 Geometry 배열 위치가 아니라 역할 이름으로 연결한다. `material.tsx`는 직접 정의한
Material 객체 또는 factory를 export하고 Experiment/Task가 이를 import해 root Geometry의 역할
map에 주입한다. `new Material(...)`은 다른 source 파일에서 사용할 수 없다.

```tsx
import { Mat, Material } from "@caemble/core";

export const Copper = (conductivity: number) =>
  new Material("Copper", "reference", {
    "electrical.conductivity": {
      dtype: "float64",
      value: Mat(conductivity),
      unit: "S.m-1",
    },
    color: "#d97706",
  });
```

Viewer는 실제 Material이나 color가 빠져도 canonical 역할 이름의 안정적인 hash 색으로 서로 다른
역할을 구분한다. 이 상태의 preview와 Experiment 저장은 허용하지만, 최종 part에 unresolved 역할이
남아 있으면 Measurement 생성과 solver 실행은 거부한다.

## Task Source (`tasks/electric.tsx`)

Task 이름은 파일명에서 등록된다. Task는 고정된 solver `name/version`과 config를 소유하며,
필요할 때만 solver-local geometry, groups, length unit을 추가한다. 모든 Task가 공통 vars를
받는다. solver 구현이 바뀌면 version도 올려야 한다.

```tsx
import { defineTask } from "@caemble/core";
import { Probe } from "../geometry";
import { Copper } from "../material";

export default defineTask({
  kernel: { name: "dc-current-density", version: "0.1.0" },
  lengthUnit: "mm",
  geometry: ({ vars }) => (
    <Probe id="probe" materials={{ body: Copper(vars.conductivity as number) }} />
  ),
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
        target: ["experiment.geometry.conductor"],
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
        target: ["experiment.surface.sourceTerminal"],
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
        target: ["experiment.surface.referenceTerminal"],
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
        key: "totalCurrent",
        methodId: "dc.total-current",
        target: ["experiment.geometry.conductor"],
        parameters: {},
      },
    ],
  }),
});
```

target은 `<scope>.<kind>.<group>` 형식이다.

- `experiment.geometry.*`, `experiment.surface.*`: 공통 physical scene
- `task.geometry.*`, `task.surface.*`: 현재 Task의 solver-local scene

각 method가 solver manifest에 선언한 `source`와 `kind`에 맞는 target만 사용할 수 있다.

## Python `simulate.py`

```python
async def simulate(*, sim, tasks, vars):
    electric = await sim.run(tasks["electric"])
    await sim.record(
        "measuredCurrent",
        electric["artifacts"]["totalCurrent"],
    )
    return electric["state"]
```

Python simulation API v3은 `sim.run`, `sim.record`, `sim.release`만 제공한다. 확률적 solver
제어가 필요하면 일반 vars로 명시한다. Python source는 import, 파일·네트워크 접근, `eval`
계열을 허용하지 않는 AST 정책을 통과해야 한다.

## Measurement와 Material snapshot

prepared Measurement는 immutable Experiment ID, complete vars, 다음 Material snapshot을 저장한다.

```text
{
  schemaVersion: 2,
  experiment: <common geometry frozen materials>,
  tasks: {
    <taskName>: <task-local frozen materials>
  }
}
```

Candidate를 만들 때 Experiment와 모든 Task의 Material을 합쳐 resolve한다. 이름과 선언이 모두
같은 Material은 한 번만 noise를 적용하므로 scene이 달라도 같은 frozen 값을 공유하고, 같은 이름의
선언이 서로 다르면 Candidate 생성을 거부한다. 각 scene snapshot에는 자신이 사용하는 subset만 남긴다.

같은 Experiment, vars, Material 값으로 Measurement를 여러 개 만들 수 있다. 생성 방식이나
seed는 Measurement에 포함하지 않는다. CAE wire payload는 정확히
`{ measurement: BuiltMeasurement }` 하나다.

## Multiphysics orchestration

각 physics kernel은 독립 Task로 선언한다. 연결 순서와 artifact 전달은 Python이 결정한다.

```python
electric = await sim.run(tasks["electric"])
thermal = await sim.run(
    tasks["thermal"],
    state=electric["state"],
    inputs={"heatSource": electric["artifacts"]["jouleHeating"]},
)

await sim.record("totalCurrent", electric["artifacts"]["totalCurrent"])
await sim.record("temperature", thermal["artifacts"]["temperature"])
sim.release(electric["artifacts"]["jouleHeating"])
return thermal["state"]
```

- `task.outputs`는 kernel이 계산할 중간 artifact를 요청한다.
- `result["artifacts"]`는 다음 kernel이나 `sim.record()`에 넘기는 opaque handle이다.
- `result["observations"]`는 branch나 loop 판단에 쓰는 작은 scalar 값이다.
- `sim.release()` 이후 artifact를 전달하거나 기록하면 실행 전체가 실패한다.
- 성공 실행에서는 Experiment `recordedData`의 모든 key를 정확히 한 번 기록해야 한다.
- undeclared, duplicate, missing RecordedData와 뒤 Task 실패는 provisional 결과 전체를 폐기한다.
- time-series는 반복 record 대신 시간축을 가진 하나의 tensor artifact로 기록한다.

## 저장과 실행 API 흐름

```text
POST /measurement/create
  { experiment_id, experiment_source_hash, vars, material_parameters }
→ prepared Measurement

CAE 실행 성공
→ POST /measurement/{id}/record
  { recorded_data: [...] }
→ RecordedData 원자 삽입 + recorded_at 설정
```

Experiment source가 달라지면 새 child revision을 저장한다. Measurement는 immutable revision을
가리키므로 예전 조건도 재현할 수 있다. 생성 요청의 source hash는 저장 직전 revision 변경을
검출하는 데만 쓰며, 불일치는 거부한다.
RecordedData 부착은 한 번만 허용하며 빈 결과 세트도 `recorded_at`으로 실행 완료를 나타낸다.

## 새 kernel 추가

`app/slaves/cae/app/solvers/<solver_name>/`에 `manifest.json`, `solver.py`, 전용 테스트를
추가한다. CAE registry는 manifest를 자동 발견한다. UI에는 manifest 사본을 두지 않으며
Solver Catalog는 같은 manifest를 Vite build 시 직접 포함한다. 변경 후 UI를 다시 빌드하고
실제 UI `BuiltMeasurement` fixture를 재생성한다.

## 검증

```powershell
Push-Location app/ui
npm run generate:cad-api
npm run check:generated
npx tsc -b
npm test
npm run lint
npm run build
Pop-Location

Push-Location app/api
.\.venv\Scripts\python.exe -m pytest -q
Pop-Location

Push-Location app/slaves/cae
poetry run pytest -q
Pop-Location
```
