# Caemble API

FastAPI와 PostgreSQL을 사용하는 Caemble 백엔드다. 인증 테이블은
`app/user_auth/db.py`, Caemble 도메인 테이블은 `app/db.py`에서 관리한다.

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

## CRUD 계약

각 도메인 router는 공통 `utils/crud`를 사용해 다음 경로만 제공한다.

- `POST /<table>/list`
- `POST /<table>/upsert`
- `DELETE /<table>/`

대상 table 경로는 `material`, `material_name`, `material_parameter`,
`material_parameter_qualifier`, `geometry`, `structure`, `experiment`, `sample`,
`setup`, `measurement`, `recorded_data`, `designer_model`, `predictor_model`이다.

`user_id IS NULL`인 행은 공개 데이터다. 익명 사용자는 공개 행을 조회할 수
있고, 로그인 사용자는 공개 행과 본인 행을 조회하며 본인 행만 변경할 수 있다.
관리자는 모든 범위를 관리할 수 있다. `MaterialParameterQualifier`는 별도
`user_id` 없이 부모 `MaterialParameter`의 범위를 상속한다.

목록 body의 `scope`는 `visible`, `mine`, `public` 중 하나다. 기본값
`visible`은 기존 공개+본인 동작을 유지하고, `mine`은 로그인 사용자의 행만,
`public`은 공개 행만 반환한다.

공개 행의 FK는 공개 행만 가리킬 수 있다. 사용자 행의 FK는 공개 행 또는 같은
사용자의 행을 가리킬 수 있다. Geometry, Structure, Experiment의 parent 관계는
순환을 허용하지 않으며, 부모 삭제 시 자식은 가장 가까운 생존 조상으로 이동한다.

## 도메인 테이블

- Material, MaterialName, MaterialParameter, MaterialParameterQualifier
- Geometry, Structure, Experiment
- Sample, Setup, Measurement, RecordedData
- DesignerModel, PredictorModel

모든 도메인 테이블은 `id`, `created_at`, `updated_at`을 가진다. JSON 데이터는
JSONB, 코드 임베딩은 768차원 pgvector로 저장한다. MaterialName은 공개 범위와
사용자별 범위에서 각각 유일하다.

## Measurement 저장 경계

RecordedData에는 UI가 완성한 `quantity_kind`, `tensor_order`, `dtype`,
`data_schema`, `data`를 그대로 저장한다. API는 QuantityKind catalog나 CAE 계약
package를 사용하지 않으며 unit 호환성, tensor shape, dtype byte 수, base64 내용
등을 해석하지 않는다. `data_url`과 `file_size`는 신규
Measurement 저장에서도 `NULL`이다.

## 실행

```powershell
cd app
poetry run python -m uvicorn main:app --reload --host 0.0.0.0
```

테스트는 설정된 PostgreSQL의 transaction 안에서 실행된다.

```powershell
poetry run pytest -q
```
