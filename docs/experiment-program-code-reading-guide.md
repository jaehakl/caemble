# CAE 실행 코드 읽기 가이드

현재 실행 경계는 한 방향이다.

```text
Structure/Experiment TS authoring
→ UI compile/evaluate/canonicalize
→ { sample, setup }
→ GPStation cae slave
→ sim.record()된 DataTensor
→ Viewer/Analysis와 Measurement JSONB
```

브라우저 로컬 solver와 fallback은 없다. API도 물리 데이터를 해석하지 않는다.

## 책임 경계

| 계층 | 책임 |
| --- | --- |
| UI | 전체 QuantityKind/Material catalog, unit 변환, solver authoring descriptor, BuiltSample/BuiltSetup 생성 |
| CAE slave | Python `simulate()` 실행, 등록 solver 계산, tensor 구조 검증, record streaming |
| API | UI가 보낸 RecordedData 컬럼과 JSON을 불투명하게 저장·반환 |

별도 `contracts/cae` JSON 원본, npm contract package, Python contract wheel과
contract hash 검사는 없다.

## 1. UI catalog와 solver descriptor

먼저 다음 순서로 읽는다.

1. [`quantitykind/data`](../app/ui/src/lib/quantitykind/data): domain별 QuantityKind
2. [`material/data`](../app/ui/src/lib/material/data): domain별 Material property
3. [`dcCurrentDensity/descriptor.ts`](../app/ui/src/lib/cad/simulation/kernels/dcCurrentDensity/descriptor.ts)
4. [`steadyStateHeat/descriptor.ts`](../app/ui/src/lib/cad/simulation/kernels/steadyStateHeat/descriptor.ts)
5. [`generate-cad-api.mjs`](../app/ui/scripts/generate-cad-api.mjs)

전체 catalog는 UI에만 있다. CAD API generator도 이 TypeScript 원본과 등록된
descriptor를 직접 읽는다.

## 2. 실행 manifest

[`authoring.ts`](../app/ui/src/lib/cad/simulation/authoring.ts)가 task config를 solver
descriptor 기준으로 canonicalize하고 다음 v3 manifest를 만든다.

```ts
type SimulationProgram = {
  formatVersion: 3
  simulationApiVersion: 1
  pythonSource: string
  tasks: Record<string, {
    kernel: { name: string; version: string }
    config: unknown
  }>
  recordedData: Record<string, DataSchema & { tensorOrder: number }>
}
```

descriptor 본문, output artifact spec과 각종 실행 hash는 직렬화하지 않는다.
`tensorOrder`는 UI가 QuantityKind catalog에서 계산한다.

## 3. BuiltSample/BuiltSetup canonicalization

[`realization.ts`](../app/ui/src/lib/cad/execution/realization.ts)의
`canonicalizeCaeRealizations()`가 원격 전송 직전의 마지막 경계다.

- geometry 좌표를 solver의 reference length unit으로 변환한다.
- solver가 쓰는 Material property만 해당 canonical unit과 dtype으로 변환한다.
- task config는 이미 authoring descriptor 기준으로 정규화된 값을 사용한다.
- 등록되지 않은 solver 또는 서로 다른 geometry 기준 단위를 섞은 setup은 거부한다.

## 4. 브라우저 원격 실행

공개 인터페이스는
[`client.ts`](../app/ui/src/features/cae/client.ts)의 함수 하나다.

```ts
simulate(sample, setup, { signal, onStatus, onProgress, onRecord })
```

client는 다음을 내부 처리한다.

- start payload를 정확히 `{ sample, setup }`으로 구성
- 256 MiB input 제한과 16 MiB attachment sharding
- `cae.simulation.start`와 한 번에 하나인 `cae.simulation.next`
- record sequence/ACK backpressure
- status/progress event와 HTTP kill
- 한 run 64 MiB RecordedData 제한
- 실패·취소 시 provisional attachment 정리

완료값은 이름별 `DataTensor` map인 `RecordedData`뿐이다.

## 5. Python CAE slave

별도 GPStation checkout의 `app_v1/slaves/cae`는 다음 순서로 읽는다.

1. `handlers.py`: start/next handler와 request attachment decode
2. `runtime.py`: run lifecycle, ACK, Python orchestration, artifact ownership
3. `program.py`: `simulate()` AST allowlist
4. `kernels.py`: 등록 solver의 최소 spec과 계산 구현
5. `tensor.py`: dtype/tensorOrder/shape/ticks/raw bytes 검증과 sharding

CAE는 `name + version`으로 solver를 선택한다. `kernels.py`에는 DC와 Heat가 실제로
쓰는 `m`, `S.m-1`, `W.m-1.K-1`, parameter와 artifact spec만 있다. 일반 tensor
codec은 `quantityKind`나 `unit` catalog를 조회하지 않는다. 잘못된 solver 입력 단위는
변환하지 않고 해당 solver가 명확한 domain error로 거부한다.

Python에서 허용되는 실행 API는 네 개다.

```python
sim.run
sim.record
sim.release
sim.random
```

import, 파일·네트워크 접근과 `eval` 계열은 AST 정책으로 차단한다. 이는 신뢰된
Experiment용 가드레일이며 OS sandbox를 대신하지 않는다.

## 6. DataTensor와 Measurement

[`dataTensor.ts`](../app/ui/src/lib/cad/model/dataTensor.ts)는 inline, attachment,
base64와 legacy JSON을 같은 accessor로 읽는다. Viewer와 Analysis는 필요한 slice만
읽고 export 시에만 전체 값을 materialize한다.

[`MeasurementPage.tsx`](../app/ui/src/pages/measurements/MeasurementPage.tsx)는 실행
manifest의 schema와 record를 결합해 다음 값을 완성한다.

- `quantity_kind`
- `tensor_order`
- `dtype`
- `data_schema`
- inline 또는 tensor encoding v1 base64 `data`

API의 [`measurement_service.py`](../app/api/app/service/measurement_service.py)는 이를
변형하지 않고 저장한다. QuantityKind 존재 여부, unit 호환성, shape, dtype byte 수와
base64 내용을 교차 검증하지 않는다. `data_url`과 `file_size`는 신규 저장에서도
`NULL`이다.

## 검증 순서

```powershell
cd E:\caemble\app\ui
npm run generate:cad-api
npm run check:generated
npx tsc -b
npm test
npm run lint
npm run build

cd E:\caemble\app\api
.\.venv\Scripts\python.exe -m pytest -q

cd E:\gpstation\app_v1\slaves\cae
poetry lock
poetry install
poetry run pytest -q
```

마지막으로 UI import graph에 로컬 solver runtime이나 contract package가 없고,
CAE import graph에 전체 catalog, UCUM 변환기와 contract wheel이 없으며 GPStation
SDK/server source diff가 없는지 확인한다.
