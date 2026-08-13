# Caemble API

FastAPI와 PostgreSQL을 사용하는 Caemble 백엔드다. 인증 테이블은
`app/user_auth/db.py`, GPStation 실행 테이블은 `app/gpstation/db.py`, Caemble
도메인 테이블은 `app/db.py`에서 관리한다.

## 초기 설정과 migration

`.env.example`을 `.env`로 복사하고 PostgreSQL 연결, Google OAuth client,
JWT secret, 앱 origin을 설정한다. 새 개발 DB에는 다음 명령으로 전체 schema와
`vector` 확장을 만들고 `user`, `admin` 역할을 멱등적으로 시드한다.

```powershell
poetry install --no-root
poetry run alembic upgrade head
poetry run alembic current
```

초기 Alembic revision은 인증 및 전체 도메인 테이블, OAuth provider enum,
index와 FK를 포함한다. 이후 모델 변경은 반드시 새 revision으로 반영한다.

## Google OAuth와 JWT

- `GET /auth/google/start?return_to=...`는 state, nonce, PKCE를 만들고 Google로 이동한다.
- `GET /auth/google/callback`은 검증된 Google identity와 사용자를 생성하거나 다시 연결한다.
- access/refresh JWT는 종류가 구분되며 HttpOnly 쿠키로만 전달된다.
- `GET /auth/me`, `GET /auth/refresh`, `POST /auth/logout`이 계정 상태를 관리한다.
- refresh token은 stateless JWT로 재발급하며 별도 서버 session store를 두지 않는다.

`return_to`는 `APP_BASE_URL`과 `ALLOWED_APP_ORIGINS`에 포함된 origin으로만
제한된다. 로컬 HTTP에서는 `SECURE_COOKIES=false`, HTTPS 운영에서는
`SECURE_COOKIES=true`를 사용하고 필요할 때만 `COOKIE_DOMAIN`을 설정한다.

## 통합 job runtime

Caemble은 GPStation 연결 정보를 저장하지 않고 `/v1` client/launcher API와
`/web` 관리 API를 직접 제공한다. Access Token 원문은 생성 응답에 한 번만
표시하고 DB에는 SHA-256 hash와 표시용 prefix만 저장한다.

서버 시작 시 `../slaves/*/manifest.json`을 UTF-8로 직접 읽어 `id`, `name`,
`module`과 중복을 검증한다. 등록되지 않은 `slave_app_id`의 job과 launcher는
거부된다. 런처 연결과 job dispatcher는 프로세스 메모리를 사용하므로 API는
반드시 단일 worker/replica로 실행한다. 애플리케이션은 중복 runtime 시작을
DB 잠금으로 차단하지 않으므로 실행 환경에서 단일 인스턴스를 보장해야 한다.
재시작 시 진행 중 job은 실패로 복구된다.

GPStation 호환 API의 ORM, 요청/응답 model, router, service와 보안 utility는
`app/gpstation` 패키지에서 함께 관리한다. `/v1`은 외부 SDK와 launcher용 bearer
token API이며, `/web`은 Caemble 쿠키와 CSRF 보호를 사용하는 관리 API다.

## CRUD 계약

카탈로그와 model artifact router는 공통 `utils/crud`를 사용해 다음
경로를 제공한다.

- `POST /<table>/list`
- `POST /<table>/upsert`
- `DELETE /<table>/`

대상 table 경로는 `material`, `material_name`, `material_parameter`,
`material_parameter_qualifier`, `designer_model`,
`predictor_model`이다. Experiment는 `/list`, `/save`, `/history`, `DELETE /`를,
Measurement는 `/list`, `/create`, `/{id}/record`, `DELETE /`를 사용한다.
RecordedData는 `/list`만 제공하며 직접 upsert/delete할 수 없다.

`user_id IS NULL`인 행은 공개 데이터다. 익명 사용자는 공개 행을 조회할 수
있고, 로그인 사용자는 공개 행과 본인 행을 조회하며 본인 행만 변경할 수 있다.
관리자는 모든 범위를 관리할 수 있다. `MaterialParameterQualifier`는 별도
`user_id` 없이 부모 `MaterialParameter`의 범위를 상속한다.

목록 body의 `scope`는 `visible`, `mine`, `public` 중 하나다. 기본값
`visible`은 기존 공개+본인 동작을 유지하고, `mine`은 로그인 사용자의 행만,
`public`은 공개 행만 반환한다.

공개 행의 FK는 공개 행만 가리킬 수 있다. 사용자 행의 FK는 공개 행 또는 같은
사용자의 행을 가리킬 수 있다. Experiment의 parent 관계는 순환을 허용하지 않으며,
부모 삭제 시 자식은 가장 가까운 생존 조상으로 이동한다.

## 불변 Geometry module 계약

사용자는 `PUT /auth/geometry-namespace`로 새 Repository에 사용할 기본 namespace를
설정하고 언제든 다른 사용자가 예약하지 않은 값으로 변경할 수 있다. 변경해도 기존
Repository의 불변 namespace와 Published Geometry 좌표는 바뀌지 않는다.
Geometry 좌표는
`caemble:geometry/<namespace>/<repository>/<package>@<major>.<minor>.<patch>`이고
prerelease, range와 `latest`는 허용하지 않는다. 모든 dependency는 같은 owner의
Repository 안에 있어야 하며 published version의 source는 수정하지 않는다. Module
format v3 source는 PascalCase named `Geometry<Props>` 함수 component를 하나 이상
export하고, 여러 component를 함께 export할 수 있다. default/static/helper value export는
허용하지 않는다. Geometry dependency는 source의 named exact-coordinate import가 유일한
원본이며 서버가 `geometry_imports` projection을 source에 맞춰 생성한다. Workbench draft만
`@local` coordinate를 사용할 수 있고 Published source에는 exact SemVer만 저장된다. props
계약은 TypeScript source에만 있고 별도 DB metadata로 저장하지 않는다.
참조가 없는 Version과 Package만 검증된 정리 API로 삭제할 수 있다.
사용자가 삭제되면 repository는 owner FK만 `NULL`로 바뀌고 namespace와 좌표를
보존한 채 자동 archive된다. 이 orphan graph는 admin만 조회할 수 있고 namespace는
재사용할 수 없다.

- `POST /geometry/repositories/list`, `POST /geometry/repositories`
- `PUT /geometry/repositories/{id}`, `POST /geometry/repositories/{id}/archive`
- `POST /geometry/packages/list`, `DELETE /geometry/packages/`
- `POST /geometry/versions/list`, `DELETE /geometry/versions/`
- `GET /geometry/versions/{id}/resolve`, `POST /geometry/versions/{id}/archive`
- `POST /geometry/versions/{id}/dependents/list`
- `POST /geometry/versions/{id}/experiments/list`, `POST /geometry/versions/usage`
- `POST /geometry/publish/plan`, `POST /geometry/publish`

publish 요청은 local draft source와 선택 target을 보내고 서버가 Tree-sitter TSX 분석으로
도달 가능한 local dependency closure, named import projection, cycle/깊이/크기 제한과
child-first Merkle hash를 다시 계산한다. plan은 `@local`을 최종 exact coordinate로 바꾼
source와 replacement를 반환한다. `publish`는 사용자가 확인한 `planHash`를 재검증한 뒤 한
transaction으로 version과 import projection을 만든다. `repositoryId`가 있는 draft는
해당 기존 Repository의 namespace를 사용하고, 없는 새 Repository draft만 사용자의
현재 기본 namespace를 사용한다. 새 draft의 repository/package가 없으면 publish
transaction 안에서 함께 생성한다. SemVer 충돌은
`geometry_version_conflict` 409와 suggested version을 반환한다. resolve/publish snapshot의
`moduleFormatVersion`은 3이고 CAD API version은 5다.

Experiment source bundle v4는 `geometry.tsx`를 항상 포함한다. Experiment는
`./geometry`, Task는 `../geometry`에서 필요한 named component를 import한다.
`geometry.tsx`는 exact Geometry coordinate에서 named component를 import하고 여러 이름을
export할 수 있다. `geometrySnapshot.schemaVersion=2`는 `entryImports`와 전체 reachable
module source/hash/import projection을 canonical order로 보존한다. 저장 시 API가
`geometry.tsx`에서 snapshot을 독립 재생성해 요청 값과 대조하고
`experiment_geometry_imports` 및 `experiment_geometry_modules` projection을 갱신한다.

## 도메인 테이블

- Material, MaterialName, MaterialParameter, MaterialParameterQualifier
- GeometryRepository, GeometryPackage, GeometryVersion, GeometryImport, Experiment
- Measurement, RecordedData
- DesignerModel, PredictorModel

모든 도메인 테이블은 `id`, `created_at`, `updated_at`을 가진다. JSON 데이터는
JSONB, 코드 임베딩은 768차원 pgvector로 저장한다. MaterialName은 공개 범위와
사용자별 범위에서 각각 유일하다.

## Measurement 저장 경계

`POST /measurement/create`는 Experiment source hash를 확인한 뒤 Experiment,
전체 vars, 동결된 material parameter snapshot을 가진 pending Measurement를 항상
새로 만든다. 결과는 `POST /measurement/{id}/record`로 한 번만 원자적으로
기록한다. 완료된 Measurement를 다시 실행하려면 새 Measurement를 만들어야 한다.

RecordedData에는 UI가 완성한 `quantity_kind`, `tensor_order`, `dtype`,
`data_schema`, `data`를 그대로 저장한다. API는 QuantityKind catalog나 CAE 계약
package를 사용하지 않으며 unit 호환성, tensor shape, dtype byte 수, base64 내용
등을 해석하지 않는다. `data_url`과 `file_size`는 신규
Measurement 저장에서도 `NULL`이다.

## 실행

```powershell
cd app/api/app
poetry run python -m uvicorn main:app --reload --host 0.0.0.0
```

운영 실행에는 `--workers`를 추가하지 않는다.

테스트는 설정된 PostgreSQL의 transaction 안에서 실행된다.

```powershell
poetry run pytest -q
```
