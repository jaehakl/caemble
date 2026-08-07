# CAE 실행 코드 읽기 가이드

현재 실행 경계는 한 방향이다.

```text
Structure/Experiment TS authoring
→ UI compile/evaluate/raw serialization
→ { sample, setup }
→ GPStation cae slave
→ manifest validation and UCUM conversion
→ sim.record()된 DataTensor
→ Viewer/Analysis와 Measurement JSONB
```

브라우저 로컬 solver와 fallback은 없다. API도 물리 데이터를 해석하지 않는다.

## 책임 경계

| 계층      | 책임                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------ |
| UI        | authoring과 BuiltSample/BuiltSetup 생성, live Solver Catalog 표시                                |
| CAE slave | solver manifest 소유, 계약 검증과 UCUM 변환, Python `simulate()`와 solver 실행, record streaming |
| API       | UI가 보낸 RecordedData 컬럼과 JSON을 불투명하게 저장·반환                                        |

별도 `contracts/cae` JSON 원본, npm contract package, Python contract wheel과
contract hash 검사는 없다.

## 1. CAE manifest와 live Solver Catalog

먼저 다음 순서로 읽는다.

1. GPStation CAE `app/solvers/*/manifest.json`: solver별 단일 계약 원본
2. GPStation CAE `app/solver_framework/registry.py`: schema 검증, 자동 발견, lazy import
3. GPStation CAE `app/handlers.py`: `cae.solvers.manifests` attachment 응답
4. [`manifests.ts`](../app/ui/src/features/cae/manifests.ts): 전체 응답 검증
5. [`SolverCatalogPage.tsx`](../app/ui/src/pages/catalog/solvers/SolverCatalogPage.tsx): 연결별 메모리 cache와 표시

UI에는 solver manifest 사본, generated solver catalog, solver별 authoring builder가
없다. Catalog는 연결된 CAE worker가 보내는 manifest의 `descriptor`만 표시한다.

## 2. 실행 manifest

[`authoring.ts`](../app/ui/src/lib/cad/simulation/authoring.ts)의 범용
`defineTask({ name, version }, config)`가 config와 작성 단위를 그대로 다음 v3
manifest에 넣는다.

```ts
type SimulationProgram = {
  formatVersion: 3;
  simulationApiVersion: 1;
  pythonSource: string;
  tasks: Record<
    string,
    {
      kernel: { name: string; version: string };
      config: unknown;
    }
  >;
  recordedData: Record<string, DataSchema & { tensorOrder: number }>;
};
```

solver descriptor 본문과 output artifact spec은 직렬화하지 않는다. RecordedData의
`tensorOrder`만 UI가 자체 DataSchema를 완성하기 위해 계산한다.

## 3. BuiltSample/BuiltSetup 직렬화

[`realization.ts`](../app/ui/src/lib/cad/execution/realization.ts)가 실제 authoring을
BuiltSample/BuiltSetup으로 만들고, [`request.ts`](../app/ui/src/features/cae/request.ts)가
attachment를 분리한다.

- geometry의 `lengthUnit`, Material property unit, task parameter unit을 보존한다.
- UI는 solver별 정규화나 호환성 검사를 하지 않는다.
- CAE가 각 task의 manifest를 선택한 뒤 geometry와 Material의 solver-local view를 만든다.

## 4. 브라우저 원격 실행

공개 인터페이스는
[`client.ts`](../app/ui/src/features/cae/client.ts)의 함수 하나다.

```ts
simulate(sample, setup, { signal, onStatus, onProgress, onRecord });
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
4. `solver_framework/registry.py`: manifest 자동 탐색과 lazy solver import
5. `solver_framework/validation.py`, `units.py`, `world.py`: 계약 검증과 단위 변환
6. `solvers/*/solver.py`: solver별 계산
7. `tensor.py`: dtype/tensorOrder/shape/ticks/raw bytes 검증과 sharding

CAE는 `name + version`으로 manifest와 solver를 선택한다. `quantityKind`는 manifest와
정확히 일치해야 하며 호환 가능한 UCUM 단위는 manifest 단위로 변환한다. geometry와
Material 원본은 변경하지 않고 사용하는 solver의 local view에서만 변환한다.

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
