# Caemble deployment

Caemble은 Ubuntu의 FastAPI 서비스와 정적 Vite UI로 배포한다. 사용자 CAD 코드를 실행하는
runner는 메인 앱과 다른 origin에서 제공한다. Experiment 입력은 브라우저 또는 모노레포의
Node CLI에서 완성해서 업로드한다. API 호스트에는 Node 런타임이 필요하지 않다.

- 메인 앱: `https://www.caemble.com`
- runner: `https://code-to-cad.caemble.com`
- FastAPI: `127.0.0.1:8000`
- 정적 루트: `/var/www/caemble/current`
- 저장소: `/home/ubuntu/caemble`

## API 환경

대용량 입력·결과에는 기존 AWS Bucket 설정을 사용한다. 배포 전에
[S3 직접 전송 설정](object-storage.md)의 버킷 권한과 브라우저 CORS를 확인한다.
배포 스크립트는 `.env`의 endpoint로 Nginx CSP를 렌더링한다.

`app/api/.env.example`을 `app/api/.env`로 복사하고 PostgreSQL, Google OAuth, JWT,
cookie 설정을 운영값으로 설정한다. 인증 cookie가 runner origin으로
전달되지 않도록 `COOKIE_DOMAIN`은 비워 둔다.

PostgreSQL에는 pgvector가 있어야 한다. baseline migration이 extension과 application
table, 기본 user/admin role을 만든다.

## Calculation 공유 정의 전환 (revision 000000000016)

이 migration은 `calculations`의 ID를 보존한 채 정확히 같은 UTF-8 코드를
`calculation_sources`에 통합하고 `source_id` FK로 연결한다. 이름·설명·revision·preflight·
입력 Record 연결·CalculationData·객체 저장소 참조는 Experiment별 연결에 남는다.
코드의 공백·주석·줄바꿈은 정규화하지 않는다. 공유 정의는 DB trigger로 UPDATE를 막으며,
참조 없는 정의도 이번 전환에서 자동 삭제하지 않는다.

1. 기존 배포 절차에 따라 작업을 종료하고 API 및 다른 DB writer를 중단한다.
   DB 백업과 이전 서버 release를 확보한다. 기존 API와 새 스키마를 혼용하지 않는다.
2. 새 release의 `app/api`에서 `poetry run alembic upgrade head`를 실행한다.
   migration은 `calculations`에 배타 잠금을 잡고 하나의 transaction으로 전환한다.
3. `ready` 항목의 해시가 코드와 다르면 해당 ID를 표시하고 전체 전환을 rollback한다.
   기존 release에서 해당 Calculation의 실제 코드를 확인하고 다시 preflight·저장한 뒤 재시도한다.
   기존 해시만 덮어써 검증 상태를 유지하지 않는다.
4. `poetry run alembic current`로 revision을 확인한 후 새 API와 UI·CLI를 배포한다.
   목록 응답의 기존 `id`, `source_code`, `source_hash`와 추가된 `source_id`를 확인한다.
   서로 다른 Experiment에서 같은 코드가 같은 `source_id`를 가지며 결과는 각자 유지되어야 한다.

되돌릴 때도 writer를 중단한 상태에서 새 release의 `app/api`에서
`poetry run alembic downgrade 000000000015`를 실행하고 이전 서버 release를 복원한다.
다운그레이드는 공유 코드를 각 Calculation 행에 다시 채우므로 기존 ID와 결과를 유지한다.
운영 DB 전환은 개발 검증과 별개다. 개발 검증은 다음 명령으로 생성·삭제되는 임시 PostgreSQL DB에서 수행한다.

```powershell
cd app/api
$env:RUN_CALCULATION_DB_TESTS = '1'
poetry run pytest tests/test_calculation_sources.py tests/test_experiment_calculation_copy.py tests/test_calculation_database.py -q
```

## UI artifact

Windows checkout에서 다음을 실행한다.

```powershell
cd E:\caemble
deployment\build-ui.bat
```

이 명령은 JavaScript SDK, 웹 UI와 모노레포 Node CLI를 빌드한다. 웹 artifact와 관련 source는
같은 release에 포함한다.

- `deployment/caemble-ui.tar.gz`: 웹 UI와 격리된 browser runner
- `app/ui/dist-cli/caemble.cjs`: 해당 모노레포에서 사용하는 CLI. Node 24.14 이상과 CAE Poetry 환경을 사용한다.

CLI나 인증정보를 웹 서버 정적 루트에 복사하지 않는다. 기존 CAE preparation artifact와
`CAE_NODE_EXECUTABLE`, `CAE_PREPARATION_*` 설정은 사용하지 않는다.

## 클라이언트 빌드 전환

기존 데이터는 유지하고 일반 Alembic migration을 적용한다. 이번 전환에서는
`RESET_API_SCHEMA`를 사용하지 않는다. API·UI·Launcher·CAE를 동일 commit으로 전환한다.

```bash
(
    set -e
    git fetch --prune
    release_update="$(mktemp)"
    trap 'rm -f "$release_update"' EXIT
    git show '@{upstream}:deployment/update.sh' > "$release_update"
    bash "$release_update"
)
```

첫 전환에서도 기존 `update.sh`가 먼저 checkout을 갱신하지 않도록, 위 명령으로 새 배포 스크립트를
checkout 외부에서 실행한다.

스크립트는 `git fetch` 후 upstream commit을 고정하고, 해당 commit의 Nginx 설정·웹
artifact를 임시 디렉터리에 준비한다. 이때 실행 중인 checkout의 코드와 canonical Catalog는 변경하지
않는다. Nginx admission gate를 설치하여 신규 배치·retry·commit을 잠시 차단한 뒤 API를 즉시 정지한다.
활성 배치와 worker cleanup 완료는 기다리지 않으며, 실행 중인 시뮬레이션은 중단된다.

API 종료 전에 `/etc/systemd/system/<API_SERVICE>.service.d/99-caemble-stop.conf`에
`TimeoutStopSec`, `KillMode=control-group`, `SendSIGKILL=yes`를 설치하고 `daemon-reload`한다.
`API_SERVICE`에 이미 `.service`가 있으면 중복으로 붙이지 않는다. 기존 `ExecStart`는 유지한다.
`deployment/update.sh` 상단의 `API_STOP_TIMEOUT_SECONDS` 한 곳에서 종료 제한을 설정하며,
systemd 설정과 안내 로그에 같은 값을 사용한다. 이 시간 안에 정상 종료하지 않으면
systemd가 서비스 프로세스를 강제 종료한다. 로그에는 종료 시작과
소요 시간을 표시한다. 이 제한은 API 종료 대기에만 적용하며 dependency 설치·migration 시간은 포함하지 않는다.

Launcher는 API 연결 해제 시 기존 worker 종료 처리를 수행하고, 3초 안에 끝나지 않는 CAE worker는
프로세스 트리를 강제 종료한다. 원격 worker의 실제 종료 시점은 연결 단절 감지에 영향을 받으며,
배포는 완료 확인을 기다리지 않는다. 중단 작업은 기존 연결 해제·재시작 복구로 종료 상태에 반영하며,
재시작 복구 시 `failed`와 `server restarted` 사유를 유지한다. 완료 결과는 보존하고 아직 실행되지 않은
대기 작업은 재시작 후 실행한다.

API 정지 후 고정한 commit으로 fast-forward하여 API와 Catalog를 함께 전환한다.
dependency와 migration을 적용한 후 준비한 정적 release를 원자적으로 전환하고 API와 Nginx를 다시
올린 뒤 신규 제출을 허용한다. schema reset은 사용하지 않는다. `UI_ARTIFACT` 또는
`NGINX_CONFIG_SOURCE`를 지정하면 해당 파일을 임시 디렉터리에 복사하여 사용한다.

migration은 chunk 저장소, Job artifact metadata, Calculation revision을 추가하고 내부 Agent
credential 테이블을 제거한다. 삭제한 provider secret은 downgrade로 복원되지 않는다.
오래된 클라이언트의 서버 build 요청은 계약 오류로 종료하며 prepare fallback은 없다.

## systemd

API는 한 프로세스로 실행한다. launcher registry가 process memory에
있으므로 동일 API를 여러 worker 또는 replica로 실행하지 않는다.

```ini
[Unit]
Description=Caemble FastAPI service
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu/caemble/app/api/app
EnvironmentFile=/home/ubuntu/caemble/app/api/.env
Environment=PYTHONUNBUFFERED=1
ExecStart=/home/ubuntu/.local/bin/poetry run uvicorn main:app --host 127.0.0.1 --port 8000 --workers 1 --proxy-headers --forwarded-allow-ips=127.0.0.1
Restart=always
RestartSec=3
KillMode=control-group
SendSIGKILL=yes
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

## Launcher 업데이트

기존 launcher token은 유지한다. 새 장비는 브라우저에서 Google OAuth로 로그인하고
Account에서 launcher 용도의 token을 발급한다. worker 장비의
`app/launcher/.env`에는 다음 값만 둔다.

```dotenv
CAEMBLE_API_URL=https://www.caemble.com/api
CAEMBLE_ACCESS_TOKEN=<LAUNCHER_TOKEN>
```

그 뒤 동일 commit의 SDK, launcher, CAE/AI slave dependency를 설치하고 launcher를 다시
시작한다.

```bash
cd /opt/caemble/app/launcher
poetry install
poetry run launcher
```

한 launcher는 worker와 job을 한 번에 하나만 실행한다. `models.toml`, 모델 weight, cache,
`.env`, `.venv`, VOICEVOX runtime은 장비 로컬에 둔다.
CAE manifest는 `websocket`을 선언하며 worker가 서버로 결과를 직접 업로드한다. AI 등
기존 `webrtc` manifest의 브라우저 Master 동작은 유지된다.

배포 후에는 같은 사용자 Launcher 두 대에 Repeat Run을 등록하고 브라우저를 닫은 뒤에도
진행되는지 확인한다. 재접속 시 진행·메시지·완료 알림·선택 Measurement 결과를 확인하고,
worker 중단과 실패 재시도, AI WebRTC 실행을 각각 확인한다. 배포 스크립트 자체는 이
브라우저·실제 DB·실제 worker 검증을 대신하지 않는다.


## Calculation 공유 정의·선언 계약 제거 (revision 000000000017~000000000018)

writer와 실행 작업을 중단하고 DB 백업을 확보한 뒤 새 release에서 `poetry run alembic upgrade head`를 실행합니다. API·UI·CLI를 같은 release로 배포합니다. revision 18은 CalculationSource의 선언 계약 컬럼만 제거하고 소스·해시·기존 결과·Experiment별 preflight를 보존합니다. Catalog 소스는 변경하지 않습니다. downgrade는 삭제한 컬럼을 NULL로 복원하며 계약 값은 복구하지 않습니다. revision 16의 불변 UPDATE trigger는 revision 17에서 제거되며, 애플리케이션이 소유권 및 정의 revision을 검사합니다.

같은 정의의 가장 작은 Calculation ID에서 이름·설명과 Experiment 소유자를 선택합니다. 참조 없는 정의는 소유자 없이 관리자 관리 대상으로 남깁니다. 기존 이름·설명은 `calculation_legacy_metadata`에 rollback용으로 보존합니다. 기존 코드에 계약을 추측해 추가하지 않으며, preflight 및 결과도 유지합니다. 기존 API와 새 스키마를 혼용하지 않습니다.

공유 로직 변경은 모든 연결의 결과를 무효화합니다. 운영 점검에서는 두 Experiment의 정의 ID·revision, 이름 변경의 결과 보존, 코드 변경의 모든 연결 무효화와 Experiment별 재검증을 확인합니다. 이전 revision 실행 결과가 409로 거부되는지도 확인합니다.

되돌릴 때 writer를 중단하고 새 release에서 `poetry run alembic downgrade 000000000016`을 실행한 뒤 이전 release를 복원합니다. 전환 전 이름·설명은 backup에서, 전환 후 생성된 연결은 공유 정의에서 복원합니다. 새 연결들의 이름이 이전 Experiment별 UNIQUE 제약과 충돌하면 전체 downgrade가 중단됩니다. 충돌 연결을 명시적으로 정리한 후 다시 수행하며 자동으로 연결·결과를 삭제하지 않습니다. 현재 공유 코드와 결과 무효화 이력은 이전 코드로 되돌리지 않으므로 코드 자체의 복원이 필요하면 배포 전 DB 백업을 사용합니다.

임시 PostgreSQL 검증: `RUN_CALCULATION_DB_TESTS=1`로 `tests/test_calculation_sources.py`, `tests/test_calculation_database.py`, `tests/test_experiment_calculation_copy.py`를 실행합니다. 운영 DB 적용과 Solver 실행은 별도 작업입니다.
