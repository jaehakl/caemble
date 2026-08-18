# CAE 실행 코드 읽기 가이드

현재 실행 경계는 한 방향이다.

```text
Experiment bundle v5 + complete vars
→ UI compile/evaluate + frozen Material snapshot
→ prepared Measurement
→ { measurement: BuiltMeasurement, solverContracts }
→ Caemble CAE slave
→ catalog digest/contract validation and UCUM conversion
→ sim.record()된 DataTensor
→ RecordedData 원자 저장
→ Viewer와 Analysis
```

브라우저 로컬 solver와 fallback은 없다. API는 Geometry import/export source graph와 snapshot을
검증하지만 CAD 형상이나 물리 데이터를 실행하지 않으며, immutable Experiment revision,
Measurement 조건, RecordedData를 저장한다.

## 책임 경계

| 계층      | 책임                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------- |
| UI        | Experiment authoring, 결정론적 평가, candidate 생성, Material 동결, BuiltMeasurement 구성, live Solver Catalog 표시 |
| API       | source hash가 고정된 Experiment revision, prepared Measurement, 1회성 RecordedData 트랜잭션과 소유권 검증           |
| CAE slave | 공용 SQLite snapshot 로드, 계약 검증과 UCUM 변환, Python `simulate()`와 Solver 실행, record streaming               |

별도 `contracts/cae` JSON이나 npm contract package는 없다. API와 CAE가 같은
`caemble_catalog` SQLite release를 사용하고, 요청의 `contractDigest`로 일치 여부를 검사한다.

## 1. Experiment authoring과 평가

먼저 다음 순서로 읽는다.

1. [`document.ts`](../app/ui/src/lib/cad/source/document.ts): document format 2, CAD API 7,
   bundle format 5와 필수 `geometry.tsx`/`material.tsx`를 포함한 허용 파일 검증
2. [`sourceAnalysis.ts`](../app/ui/src/lib/cad/source/sourceAnalysis.ts): import와 숨은 비결정성 정책
3. [`evaluateDocument.ts`](../app/ui/src/lib/cad/execution/evaluateDocument.ts): 별도-origin runner의
   inspect/evaluate 호출
4. [`userModule.ts`](../app/ui/src/lib/cad/execution/userModule.ts): 공통 scene, Task-local scenes,
   Simulation manifest v5 구성
5. [`vars.ts`](../app/ui/src/lib/cad/model/vars.ts): complete vars 검증과 UI용 unseeded candidate 생성

`inspect`는 `varsSchema`를 얻고, `evaluate`는 complete vars를 요구한다. 평가 snapshot은
`kind: "experiment"` discriminator와 `sourceHash`, `variables`, `varsSchema`, `scene`,
`taskScenes`, `simulationProgram`만 가진다.
Candidate 생성은 candidate를 바꿀 뿐 source document를 변경하거나 dirty 처리하지 않는다.

## 2. CAE manifest와 Solver Catalog

1. [`app/catalog`](../app/catalog): QuantityKind, Material, Solver 관계를 담은 SQLite와 reader
2. `app/slaves/cae/app/solver_framework/registry.py`: 계약 snapshot 로드, digest·구현 경로 검증, lazy import
3. `app/slaves/cae/app/handlers.py`: 외부 SDK용 `cae.solvers.manifests` 호환 응답
4. [`catalog.ts`](../app/ui/src/api/catalog.ts): Docs와 Experiment용 Catalog API client
5. [`SolverCatalogPage.tsx`](../app/ui/src/pages/catalog/solvers/SolverCatalogPage.tsx): 관계 기반 descriptor 표시

UI에는 Solver manifest 사본이나 전체 정적 catalog가 없다. Task가 고정한 Solver
`name/version`으로 runtime slice를 요청하므로 공개된 계약을 변경할 때 version도 올려야 한다.

## 3. Simulation manifest v5

각 `tasks/<taskName>.tsx`의 `defineTask({ kernel, config, ...optionalTaskGeometry })`가 평가한
kernel config와 공통 `experiment.tsx`의 RecordedData를 다음 계약에 넣는다.

```ts
type SimulationProgram = {
  formatVersion: 5;
  simulationApiVersion: 3;
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

## 4. BuiltMeasurement와 Material snapshot

[`measurement.ts`](../app/ui/src/lib/cad/execution/measurement.ts)는 evaluated Experiment와
공통/Task별 Material resolution을 하나의 `BuiltMeasurement`로 만든다.
[`resolveMaterials.ts`](../app/ui/src/features/viewer/persistence/resolveMaterials.ts)는 저장할
Material snapshot v2를 만든다.

```text
{
  schemaVersion: 2,
  experiment: <common frozen materials>,
  tasks: { <taskName>: <task-local frozen materials> }
}
```

저장된 snapshot을 다시 열 때는 같은 frozen 값만 적용한다. 새 candidate일 때만 Material
uncertainty를 새 값으로 확정한다. seed나 생성 알고리즘은 저장하지 않는다.

[`request.ts`](../app/ui/src/features/cae/request.ts)는 BuiltMeasurement의 큰 tensor를
attachment로 분리하되 geometry length unit, Material unit, Task parameter unit을 보존한다.

## 5. 브라우저 원격 실행

공개 인터페이스는 [`client.ts`](../app/ui/src/features/cae/client.ts)의 함수 하나다.

```ts
simulate(measurement, { signal, onStatus, onProgress, onRecord });
```

client는 다음을 내부 처리한다.

- start payload를 정확히 `{ measurement, solverContracts }`로 구성하고 각 digest를 runtime slice에서 전달
- 256 MiB input 제한과 16 MiB attachment sharding
- `cae.simulation.start`와 한 번에 하나인 `cae.simulation.next`
- record sequence/ACK backpressure
- status/progress event와 HTTP kill
- 한 run 64 MiB RecordedData 제한
- 실패·취소 시 provisional attachment 정리

완료값은 이름별 `DataTensor` map인 `RecordedData`뿐이다.

## 6. Python CAE slave

같은 checkout의 [`app/slaves/cae`](../app/slaves/cae)는 다음 순서로 읽는다.

1. `handlers.py`: start/next handler와 request attachment decode
2. `runtime.py`: BuiltMeasurement 검증, run lifecycle, ACK, orchestration, artifact ownership
3. `program.py`: Python simulation API v3와 `simulate()` AST allowlist
4. `solver_framework/registry.py`: SQLite 계약 snapshot과 digest 검증, lazy Solver import
5. `solver_framework/validation.py`, `units.py`, `world.py`: 계약 검증과 단위 변환
6. `solvers/*/solver.py`: solver별 계산
7. `tensor.py`: dtype/tensorOrder/shape/ticks/raw bytes 검증과 sharding

kernel world에는 두 scope만 있다.

- `experiment`: 공통 scene과 frozen materials
- `task`: 현재 Task-local scene과 frozen materials

target은 `experiment.geometry.*`, `experiment.surface.*`, `task.geometry.*`,
`task.surface.*` 중 manifest가 요구한 source/kind와 일치해야 한다. geometry와 Material 원본은
변경하지 않고 현재 solver의 local view에서만 UCUM 단위로 변환한다.

Python API v3에서 허용되는 실행 API는 다음 세 개다.

```python
sim.run
sim.record
sim.release
```

확률적 solver 제어는 일반 vars로 전달한다. import, 파일·네트워크 접근과 `eval` 계열은 AST
정책으로 차단한다. 이는 신뢰된 Experiment용 가드레일이며 OS sandbox를 대신하지 않는다.

## 7. Measurement와 RecordedData

[`useCaeMeasurementActions.ts`](../app/ui/src/features/cae-workbench/measurement/useCaeMeasurementActions.ts)는
다음 두 단계를 연결한다.

1. candidate의 complete vars와 Material snapshot으로 `/measurement/create`를 호출해 prepared
   Measurement를 만든다.
2. 선택된 prepared Measurement를 실행하고 성공한 전체 record를
   `/measurement/{id}/record`에 한 번 보낸다.

API의 [`measurement_service.py`](../app/api/app/service/measurement_service.py)는 source hash와
소유권을 확인하고 RecordedData 삽입과 `recorded_at` 설정을 한 트랜잭션으로 처리한다.
두 번째 record는 충돌이며 실패·취소 실행은 Measurement를 변경하지 않는다. 결과가 비어도
`recorded_at`이 실행 완료를 나타낸다.

[`dataTensor.ts`](../app/ui/src/lib/cad/model/dataTensor.ts)는 inline, attachment, base64와
legacy JSON을 같은 accessor로 읽는다. Viewer와 Analysis는 필요한 slice만 읽고 export 시에만
전체 값을 materialize한다. Analysis는 prepared/recorded 수를 구분하고 결과 기반 계산에는
recorded Measurement만 사용한다. 동일 입력 grouping fingerprint는 Experiment ID, canonical
vars, canonical Material 값으로 분석 시 계산하며 DB에 저장하지 않는다.

## 검증 순서

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

마지막으로 UI import graph에 로컬 solver runtime이나 contract package가 없고, CAE import
graph에 전체 UI catalog가 없으며 SDK, launcher, API와 두 slave 어디에도 외부 GPStation
checkout 절대경로나 runtime dependency가 없는지 확인한다. UI/API/CAE slave를 함께 배포한
뒤 resident CAE worker를 재시작해야 한다.
