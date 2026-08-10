# Caemble UI

Caemble UI는 React 19, React Router Data Mode, Tailwind CSS v4로 구성된 페이지 중심 웹앱이다. 홈과 공개 Structure/Experiment, 읽기 전용 카탈로그, 문서는 로그인 없이 열람할 수 있고 저장 기능은 Google OAuth 로그인이 필요하다. TSX는 Structure/Experiment 정의의 source of truth이며 preview는 격리된 runner가 만든 immutable snapshot을, simulation은 Caemble Launcher와 CAE slave를 사용한다.

주요 URL은 `/`, `/structures`, `/experiments`, `/examples/:exampleId?`, `/measurements`, `/viewer`, `/materials`, `/ai/chat`, `/launchers`, `/jobs`, `/catalog/cad`, `/catalog/materials`, `/catalog/quantity-kinds`, `/catalog/solvers`, `/docs`, `/login`, `/account`다. `/viewer`는 `/measurements`와 동일한 Measurement 실행·Recorded Data 저장 workspace를 query string을 유지한 채 연다. 기존 `/#viewer`는 `/structures?structure=new&mode=code`로 이동하고, `/#help`는 `/docs`로 이동한다.

코드 구조는 다음 경계를 따른다.

- `src/app`: provider, router, App Shell
- `src/pages`: URL 단위 페이지와 페이지 소유 상태
- `src/features`: 인증, Viewer workspace/editor/persistence, thin CAE client
- `src/components`: 앱 공통 컴포넌트와 소유 UI primitives
- `src/api`: native fetch, Zod 응답 검증, endpoint 계약
- `src/lib/cad`, `src/lib/material`, `src/lib/quantitykind`, `src/lib/solver`: 독립 Code-to-CAD 라이브러리

## Development

```bash
npm install
npm run dev
npm test
npm run lint
npm run build
npm run build-storybook
npm run test:e2e
```

`npm install`은 `../sdk/master/js`의 로컬 SDK를 연결한다. UI production build는 이 SDK를 먼저
빌드하므로 vendored package나 외부 repository checkout이 필요하지 않다.

`npm run dev`는 앱을 `http://localhost:5173`, 격리 runner를 `http://localhost:5174`에서 함께 실행한다. runner 서버는 `runner.html`을 Vite HTML 변환 없이 제공하며 HMR과 React Refresh를 주입하지 않는다. 따라서 개발 환경도 운영과 동일하게 별도 origin, `connect-src 'none'` CSP, sandboxed iframe 계약을 사용한다. 커스텀 포트를 쓸 때는 앱과 runner를 인접 포트로 실행하거나 `VITE_CAEMBLE_HOST_ORIGIN`과 `VITE_CAEMBLE_RUNNER_ORIGIN`을 모두 지정한다.

앱 개발 서버의 `/api`는 `http://localhost:8000`으로 proxy되며 prefix가 제거된다. 운영 reverse proxy도 같은 계약을 사용한다. 기본 설정은 `VITE_API_BASE_URL=/api`이고, 요청에는 HttpOnly access/refresh 쿠키를 위해 항상 credentials가 포함된다.

브라우저의 Job/WebRTC 요청도 같은 origin의 `/web/jobs`를 사용하고 로그인 HttpOnly 쿠키로
인증한다. 별도 API URL이나 브라우저 저장 Access Token은 없다. Account 화면에서 만드는
`csk_` Access Token은 외부 SDK(`client`) 또는 Launcher 등록(`launcher`)에만 사용하며
원문은 생성 직후 한 번만 표시된다.

Generated CAD authoring APIs are checked by every production build:

```bash
npm run generate:cad-api
npm run check:generated
```

QuantityKind와 Material 전체 catalog는 각각 `src/lib/quantitykind/data`와
`src/lib/material/data`의 domain별 TypeScript 파일이 원본이다. CAE kernel descriptor의
단일 원본은 Caemble의 `../slaves/cae/app/solvers/*/manifest.json`이다. UI에는 solver
manifest 사본이나 generated catalog를 두지 않는다. Vite는 이 파일들을 build-time에 직접
읽어 Solver Catalog에 포함하며, Launcher 화면도 `../slaves/*/manifest.json`의 앱 목록을
같은 방식으로 사용한다.

The CAD generator reads the element registry, local TypeScript catalogs, and
`src/lib/cad/api/authoring-manifest.json`. It generates the element
catalog/registry, JSX intrinsic types, and the pinned CAD authoring API v4.
Commit all generated changes. CI should run `npm run check:generated`; a
non-empty regeneration diff is an error.

## Experiment source bundle

An Experiment is stored atomically as `{ formatVersion: 1, files }`. The bundle
contains exactly `experiment.tsx`, `simulate.py`, and one or more independent
`tasks/<taskName>.tsx` files. Every TSX file may import only `@caemble/core`;
relative imports, Task-to-Task imports, dynamic imports, and `require()` are
rejected before execution.

`experiment.tsx` defines only the common `varsSchema` and `recordedData`.
Each Task file default-exports `defineTask({ kernel, lengthUnit, geometry,
geometryGroup, surfaceGroup, config })`, and its filename registers the Task
name. `geometry: () => null` and `lengthUnit` remain mandatory for Tasks without
visible geometry. `simulate.py` uses `async def simulate(*, sim, tasks, vars)`.

The Program tab shows `experiment.tsx` and `simulate.py` together. Sorted Task
tabs edit and preview independent scenes, while the Program preview overlays all
Task scenes after unit conversion. See [the Experiment Program guide](../../docs/experiment-program.md)
for the complete authoring and execution contract.

## External vars and deterministic evaluation

Source definition and realization values are separate:

```ts
await evaluateDocument({
  document,
  seed: 100,
  vars: { conductorSize: [20, 20, 20] },
})

await evaluateDocument({
  document,
  seed: 100,
  vars: { conductorSize: [80, 30, 10] },
})
```

The compiler caches emitted modules by SHA-256 source-project hash and compiler/API version. A new isolated evaluation reuses that emit without changing or recompiling Source. Explicit values are validated and preserved; missing schema entries are generated deterministically from `seed`. Unknown keys, tensor-shape mismatches, non-finite values, and out-of-range components fail before any model callback runs.

The same Source, external vars, and seed produce the same snapshot. Normal edits preserve the realization seed. **Reroll** changes only the seed and reevaluates the current compiled definition.

## Compilation and diagnostics

The lazily loaded Monaco TypeScript Worker is the only browser compiler path. Its settings are ES2020, strict TypeScript, CommonJS emit, JSX factory `h`, and virtual-project module resolution. Syntactic, semantic, and source-policy errors prevent runner dispatch. Runtime stack locations are mapped back to Monaco ranges with source maps.

Every diagnostic carries `file`, `range`, `code`, `severity`, and `phase`. Monaco markers and the document footer use the same diagnostics.

The editor maintains two Monaco models and one active editor instance. Monaco core and the TypeScript Worker are Vite-generated, hashed first-party assets loaded only when the Source screen is entered. No jsDelivr loader or `esbuild-wasm` runtime is used.

## Evaluation isolation

Development and production evaluation use a hidden iframe served from a separate origin. The host and runner exchange one schema-validated request through a nonce-bound `MessageChannel`. The runner creates a disposable Worker for each evaluation and terminates it after success, failure, cancellation, or timeout. The iframe keeps `sandbox="allow-scripts allow-same-origin"` so its Worker can run, while the distinct runner origin prevents it from acquiring host privileges.

The runner boundary provides the security controls:

- no host cookies, authentication state, or sensitive storage on the runner origin;
- runner CSP with `connect-src 'none'`;
- an allowlisted static-import AST policy;
- exact request/response schema and provenance checks on both sides;
- 3-second default evaluation timeout, with 10- and 30-second heavy modes;
- plain, finite, acyclic snapshot validation and complexity/binary-size limits;
- no `new Function` or `unsafe-eval` in the host application bundles.

The runner itself needs `'unsafe-eval'` because the isolated evaluation Worker executes TypeScript's CommonJS emit. That exception must never be added to the host CSP.

## Snapshot and CAE boundary

JSCAD instances do not cross the untrusted evaluation boundary. Each solid is
normalized into validated `Float64Array` vertex positions plus `Uint32Array`
polygon offsets. The UI then resolves variables, Material values, geometry,
DataSchema and task config into complete `BuiltSample` and
`BuiltSetup` values.

Simulation callers use only the thin client in `src/features/cae/client.ts`:

```ts
simulate(sample, setup, { signal, onStatus, onProgress, onRecord })
```

The client preserves author-supplied units, sends only `{ sample, setup }`,
and hides the JobSession, attachments, `start/next`,
record ACK and kill handling. Browser-local solver,
Python/TS simulation runtime and fallback execution do not exist. Only declared
and actually recorded `DataTensor` values are returned; failed or cancelled runs
discard every provisional record.

## Visual round-trip editing

The supported writable form is an object literal, or a directly referenced top-level `const` object literal. Spread, computed properties, `map`/`filter`, and other dynamic expressions can still execute, but the affected visual editor is read-only.

Group and Experiment parameter editors create source-hash-bound patches through one patch API. A patch is rejected if Source changed after analysis. Visual save is disabled whenever the current source hash differs from the evaluated snapshot hash.

## Production deployment

Set different origins at build time:

```dotenv
VITE_CAEMBLE_HOST_ORIGIN=https://app.example.com
VITE_CAEMBLE_RUNNER_ORIGIN=https://cad-runner.example.com
```

Deploy the complete `dist` output to both origins, or otherwise ensure the runner origin serves `runner.html` and every hashed asset it references from the same build. `VITE_CAEMBLE_RUNNER_ORIGIN` is mandatory in production and must differ from the host origin.

The production-origin smoke test builds once with fixed test origins and serves that same `dist` from two preview servers:

```bash
npm run test:e2e:production
```

Recommended runner headers are provided in `public/_headers`:

```text
/assets/*
  Cache-Control: public, max-age=31536000, immutable

/runner.html
  Cache-Control: no-store
  Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-eval'; worker-src 'self'; connect-src 'none'; img-src 'none'; style-src 'none'; base-uri 'none'; form-action 'none'
```

The host can use a strict policy such as `script-src 'self'; worker-src 'self'; frame-src https://cad-runner.example.com` without any external script origin or `'unsafe-eval'`. Serve gzip or Brotli through the existing CDN. Hashed assets should use the immutable one-year cache policy; HTML should not.

Do not place cookies, credentials, user data, service-worker scope, analytics, or general application endpoints on the runner origin. If browser isolation is no longer strong enough for the threat model, retain the runner protocol and replace the browser runner with a process-isolated backend sandbox.

## Limits

- Virtual project: 32 files and 1 MiB total.
- Compiler initialization/operation timeout: 5 seconds after initialization.
- Preview evaluation: 3 seconds by default; explicit 10- and 30-second heavy modes.
- Snapshot binary payload: 128 MiB, with finite-value, depth, node-count, and protocol-size checks.
- BuiltSample/BuiltSetup request: 256 MiB total.
- One run's RecordedData: 64 MiB raw bytes, with 16 MiB attachment shards.
- Physics kernels execute only in the Caemble `cae` slave.
