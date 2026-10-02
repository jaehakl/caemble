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

## Optimization 명칭과 실행 화면 전환

이 전환은 API, UI, CLI, Launcher와 evaluation·CAE worker를 같은 release로 한 번에 바꾼다.
API 경로는 `/cae/optimizations`, CLI 명령은 `optimization`, Workbench 직접 링크는
`?optimization=<id>`를 사용한다. 이전 경로·명령·쿼리 이름을 위한 별칭은 제공하지 않는다.
UI는 기존 최적화의 진행 상태를 먼저 보여 주며 새 생성 설정은 별도로 연다.

1. 현재 배포의 admission gate로 신규 생성·재개·재시도·배치 제출을 먼저 차단한다.
   조회·중지 요청은 열어 둔다. 이전 release에서 실행 중인 최적화를 중지하고 관련 Job의
   종료와 `cleanup_pending=false`, `executions_active=0`을 확인한다. 일반 배치와 Launcher의
   실행도 종료·정리한다.
2. API, Launcher와 다른 DB writer를 중단한다. DB 전체 백업과 기존
   release artifact를 보관한다. 이 전환에서 schema reset이나 이력 삭제를 사용하지 않는다.
3. 새 release의 `app/api`에서 `poetry run alembic upgrade head`를 실행하고
   `poetry run alembic current`로 결과를 확인한다. migration은 최적화 테이블·FK·index 등
   명칭을 바꾸며 기존 Optimization, Trial, 단계 이력과 요청 ID, Measurement 연결을 보존한다.
   전환 전후의 행 수와 대표 ID·관계를 비교한다. 고정된 `definition.hash`, `source_hash`,
   요청 hash와 `runtime_id`는 새 release 값으로 덮어쓰지 않는다.
4. 같은 release의 API, UI와 CLI·worker bundle을 배포하고 Launcher를 재연결한다.
   목록·상세 조회, 기존 이력과 최선 후보, 새 경로를 확인한 뒤 신규 제출을 허용한다.
   CLI 요청 영수증은 최초 사용 때 요청 ID를 유지해 새 형식으로 원자적으로 이전한다.

종료하지 않은 실행을 새 release에서 이어서 재개하는 호환성은 이 전환의 범위에 포함하지 않는다.
보존된 과거 이력의 조회와 미완료 실행의 재개를 구분한다. 과거 runtime에 고정된 미완료 항목은
새 release에서 계속 실행할 수 있다고 가정하지 말고 필요한 경우 새 최적화를 만든다.
문제가 생기면 신규 제출과 writer를 다시 중단하고 검증한 DB 백업과 이전 release를 함께 복원한다.
개발 작업은 migration 코드·테스트·운영 절차를 준비하는 데까지이며, 실제 운영 배포와 운영 DB
migration 실행은 별도의 배포 작업에서 수행한다.

아래 명령은 운영자가 검토한 배포 창에서 실행할 단계별 확인 예시다. 현재 배포의 Nginx 설정에서
admission gate가 적용되는 것을 먼저 확인한다. 일반 `deployment/update.sh`는 자체 gate를
관리하고 활성 작업의 cleanup을 기다리지 않으므로, 이 단일 전환에서는 위 순서로 각 단계를
수행하고 검증이 끝날 때까지 gate를 유지한다.

```bash
# 현재 release: 신규 제출을 막은 뒤 UI에서 실행을 중지하고 모든 cleanup 완료를 확인한다.
sudo touch /run/caemble-draining
sudo nginx -t
sudo systemctl reload nginx
# cleanup 확인 후 각 Launcher를 종료하고 API와 다른 DB writer를 중단한다.
sudo systemctl stop caemble-api
sudo systemctl is-active caemble-api  # inactive여야 한다.

# PGSERVICE는 DBA가 확인한 대상 DB 접속 설정, BACKUP_FILE은 새 백업 파일 경로다.
: "${PGSERVICE:?Set the reviewed maintenance database service}"
: "${BACKUP_FILE:?Set a new backup file path}"
test ! -e "$BACKUP_FILE"
pg_dump --format=custom --file="$BACKUP_FILE"
pg_restore --list "$BACKUP_FILE" > "$BACKUP_FILE.list"

# 같은 release의 소스·web·node artifact를 준비한 뒤 새 API checkout에서 실행한다.
cd /home/ubuntu/caemble/app/api
poetry install --only main
poetry run alembic upgrade head
poetry run alembic current  # 000000000021 (head)
poetry run alembic check
sudo systemctl start caemble-api
sudo systemctl is-active caemble-api
curl --fail --silent --show-error http://127.0.0.1:8000/openapi.json > /dev/null

# 새 web/ artifact 활성화와 Launcher 재연결 후, API 인증 환경이 설정된 checkout에서 확인한다.
cd /home/ubuntu/caemble
sh ./caemble doctor --api --json
sh ./caemble optimization list --limit 1 --json
# 대표 과거 항목의 상세·최선 후보·Measurement 관계를 UI 또는 optimization show로 확인한다.
# 모든 검증이 성공한 뒤에만 신규 제출을 다시 연다.
sudo rm /run/caemble-draining
```

검증이 실패하면 gate를 유지하고 API·Launcher를 중단한다. 새 형식으로 처리한 요청이 없는
배포 검증 단계에서만 `app/api`의 `poetry run alembic downgrade 000000000020`으로 명칭을
되돌린 뒤 이전 소스·web·node release를 함께 복원할 수 있다. 데이터 상태가 불확실하거나
새 요청을 처리했다면 준비한 DB 백업을 별도 복구 DB에 복원해 검증한 후 이전 release와 함께
전환한다. DB만 또는 실행 파일만 되돌린 혼합 상태로 writer를 시작하지 않는다.

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

이 명령은 JavaScript SDK, 웹 UI와 공통 Node runtime을 빌드한 뒤
`deployment/caemble.tar.gz` 하나를 생성한다. 같은 release의 소스와 함께 배포한다.

- `web/`: 웹 UI와 격리된 browser runner. 서버의 `update.sh`는 이 영역만 정적 루트에 설치한다.
- `node/`: CLI, CLI·evaluation 공통 worker, 선언 파일과 build metadata.

배포 파일 경로를 지정할 때는 `CAEMBLE_ARTIFACT`를 사용한다. CLI·Node worker는 웹 공개
디렉터리에 설치하지 않으며 API 서버에 Node를 설치할 필요도 없다.

CLI wrapper와 launcher는 기존 Python 표준 라이브러리로 Node 영역을
`.data/node-runtime/<runtime_id>`에 자동 준비한다. 같은 버전은 재설치하지 않고,
새 버전 준비가 실패해도 기존 파일과 실행 중인 버전은 보존한다. 이전 버전은 자동 삭제하지 않는다.
Launcher는 이전 실행 정리 후, 서버 연결 전에 한 번 준비하고 정상인 worker만 등록한다.
재접속·개별 Job은 설치를 반복하지 않는다. 준비 실패 원인은 콘솔에 표시한다.

CLI는 `CAEMBLE_PYTHON`, evaluation·CAE·launcher·저장소 루트의 기존 `.venv`, 시스템 Python
순으로 Python 3.11 이상을 찾는다. Node 24.14 이상도 필요하다. CAE 관련 로컬 명령은 기존
CAE Python 환경을 계속 사용한다. Launcher는 evaluation 가상환경을 사용한다.
사용자가 npm 빌드나 압축 해제를 수행할 필요는 없다.

`doctor` 자체는 상태만 확인한다. CLI wrapper의 준비는 명령을 시작하기 전에 수행한다.
개발용 부분 빌드는 `npm run build:node`이며, `build:cli`와 `build:evaluation`도 같은 빌드를 호출한다.
부분 빌드는 배포 압축 파일을 갱신하지 않는다. 개발 결과는 `app/ui`에서
`node dist-cli/caemble.cjs`로 직접 실행한다. 배포 파일 갱신은 `npm run build` 또는 위 배치 파일로 한다.
Optimization이 고정한 runtime metadata와 다른 bundle은 해당 평가를 실행하지 않는다.

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

Launcher 제어 연결에는 기본 30초의 재접속 유예가 있으며 그동안 신규 배정을 중단한다.
같은 boot의 재접속은 인스턴스와 예약을 대조한다. CAE 결과 WebSocket이 끊기면 해당 attempt는
실패하고 정리되며 수동 재시도가 필요하다. 유예 만료·취소·실패에 따른 프로세스 트리 종료를
확인하기 전에는 예약을 반환하지 않는다. 원격 worker의 실제 종료 시점은 연결 단절 감지에 영향을 받으며,
배포는 완료 확인을 기다리지 않는다. 중단 작업은 연결 해제·재시작 복구로 종료 상태에 반영하며,
재시작 복구 시 `failed`와 `server restarted` 사유를 유지한다. 완료 결과는 보존하고 아직 실행되지 않은
대기 작업은 재시작 후 실행한다.

API 정지 후 고정한 commit으로 fast-forward하여 API와 Catalog를 함께 전환한다.
dependency와 migration을 적용한 후 준비한 정적 release를 원자적으로 전환하고 API와 Nginx를 다시
올린 뒤 신규 제출을 허용한다. schema reset은 사용하지 않는다. `CAEMBLE_ARTIFACT` 또는
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

Launcher를 종료한 뒤 동일 checkout의 Launcher와 AI·TTS·CAE Simulation·Evaluation·Prediction
의존성을 한 번에 설치한다. Python 3.12, Poetry, Node 24.14 이상과
`deployment/caemble.tar.gz`가 필요하다. 스크립트는 현재 lockfile만 사용하고
Evaluation 번들도 준비·검사한다. 작업 디렉토리와 무관하게 실행할 수 있다.

```bash
bash /opt/caemble/li_launcher_install.sh
cd /opt/caemble/app/launcher
poetry run launcher
```

설치 중에는 Launcher 상태 잠금을 유지하며 실행 중인 Launcher가 있으면 실패한다.
Git 갱신·DB migration·Launcher 자동 종료/재시작·AI/TTS 모델 다운로드는 수행하지 않는다.
API migration과 웹 배포는 기존 `deployment/update.sh`가 담당하며, worker 장비는
같은 release의 checkout과 아카이브를 준비한 뒤 위 설치 명령을 사용한다.
기존 설정·모델·데이터와 이전 위치의 가상환경은 보존한다. 자세한 재실행 및
설정 충돌 처리 규칙은 [worker 설치 안내](workers.md#install-and-run)를 따른다.

한 launcher는 CPU·RAM·GPU 예산 안에서 여러 slave 인스턴스를 실행한다. 인스턴스당 활성 Job은
하나이며 attempt마다 새 프로세스를 만든다. `app/launcher/resources.example.toml`을
같은 폴더의 `resources.toml`로 복사하거나 `CAEMBLE_RESOURCES_FILE`로 정책 파일을 지정한다.
환경변수로 지정한 경로가 우선하며, 기본 경로는 실행 위치와 무관하게 launcher 폴더를 기준으로 한다.
기존 `.data/resources.toml`은 같은 폴더의 `resources.toml`이 없을 때만 호환용으로 읽는다.
생략한 CPU·RAM 예산은 각각 가용 논리 CPU와 물리 RAM의 절반이다. 앱·handler 기본값과
API/CLI override, RAM 여유 계산 및 GPU 공유 할당은 [worker 운영 안내](workers.md)를 따른다.
일반 작업은 기본 GPU 1개를 요청한다. `ram_budget_gb`는 Launcher RAM 예산,
`vram_budget_gb`는 작업당·장치당 VRAM 예산이며 모두 GiB 단위다. GPU별 예약 합계가
장치 용량을 넘지 않도록 배정하고, 예산에 도달한 작업만 중단한다. 실행 프로토콜 3을 위해
API·SDK·Launcher·worker를 함께 업그레이드한다. 기존 명시적 CPU 전용 설정은 유지된다.
Launchers 화면은 예산과 인스턴스 상태를 표시하며 설정 파일은 장비에서 편집한다.
`models.toml`, 모델 weight, cache,
`.env`, `.venv`, VOICEVOX runtime은 장비 로컬에 둔다.
CAE manifest는 `websocket`을 선언하며 worker가 서버로 결과를 직접 업로드한다. AI 등
기존 `webrtc` manifest의 브라우저 Master 동작은 유지된다.

배포 후에는 launcher 한 대에 작은 Batch를 등록하여 두 Job의 실행 시간이 실제로 겹치고,
자원 부족으로 대기한 Job이 정리 후 시작되는지 확인한다. 한 Job의 취소가 다른 Job에 영향을
주지 않아야 한다. 브라우저를 닫은 뒤에도 실행이 진행되고 재접속 시 진행·메시지·완료 알림·
선택 Measurement 결과가 복구되는지 확인한다. 제어 연결 재접속, 결과 연결 중단과 수동 재시도,
AI WebRTC 실행도 각각 확인한다. 배포 스크립트 자체는 이
브라우저·실제 DB·실제 worker 검증을 대신하지 않는다.

## VRAM 예산 전환 (revision 000000000027)

활성 작업의 프로세스 트리 정리를 확인하고 Launcher와 API writer를 중단한 뒤
새 release에서 `poetry run alembic upgrade head`를 적용한다. API·SDK·Launcher·worker·UI·CLI를
같은 release로 갱신한다. 실행 프로토콜 3은 구버전 Launcher와 연결하지 않는다.

Migration은 Job·attempt·training 요청의 `gpu_memory_bytes`를 1024³으로 나누어
`vram_budget_gb`로 옮기고, 0은 생략한다. Evaluation 입력에 고정된 자식 요청도 변환한다.
완료된 allocation 바이트 이력은 보존한다. 불변 Hybrid 정의와 fingerprint는 유지하며,
그 정의에서 새 요청을 만들 때만 예전 자원 프로필을 변환한다.

장비의 `resources.toml`은 자동 변경하지 않는다. `ram_budget_bytes`를 1024³으로 나눈
`ram_budget_gb`로, 작업별 `gpu_memory_bytes`를 같은 방식으로 `vram_budget_gb`로 바꾼다.
CLI는 `--vram-budget-gb`를 사용한다. 생략한 VRAM 예산은 전체 장치 독점 예약이다.
작은 CUDA 작업으로 동시 실행, 예산 도달 종료, 다른 작업 지속, 자식 프로세스 정리와
메모리 할당·해제 후 감시값을 확인한다.

Rollback은 실행과 writer를 중단한 상태에서 `poetry run alembic downgrade 000000000026`을
적용한 뒤 이전 release로 함께 되돌린다. 요청 예산은 올림한 바이트 값으로 복원되지만,
완료된 allocation 이력은 변환하지 않는다. 운영 DB 적용과 장비 검증은 배포 단계에서 수행한다.

## 공통 실행·자원 계약 전환 (revision 000000000019)

이 revision의 Execution protocol 2는 launcher 설치, boot, 연결 session, slave 인스턴스, Job,
attempt와 예약을 구분한다. API·SDK·launcher·CAE/AI·UI·CLI를 같은 release로 갱신한다.
이전 실행 메시지를 허용하는 호환 모드는 없다. 기존 완료 Measurement와 RecordedData는
보존하며 입력 고정 및 Batch commit 절차도 유지한다.

전환 전에 활성 작업과 launcher를 종료하고 API 및 DB writer를 중단한다. DB 백업과 이전
release를 확보한 뒤 새 release에서 `poetry run alembic upgrade head`를 적용하고
`poetry run alembic current`로 revision을 확인한다. Migration은 launcher 식별·자원 보고,
Job 실행 식별·자원 요청과 `execution_attempts` 이력을 추가한다. Schema reset은 사용하지 않는다.
새 API를 올린 뒤 같은 release의 launcher를 시작하고 위 병렬 실행 점검을 수행한다.

Rollback도 writer와 launcher를 중단한 상태에서 수행한다. 정리되지 않은 예약이 있는 동안은
revision 19 downgrade가 거부된다. 각 프로세스 트리 종료와 API의 정리 기록을 확인한 후
`poetry run alembic downgrade 000000000018`을 실행하고 이전 release를 복원한다.
개발 검사 통과는 운영 DB migration과 장비별 프로세스 containment 검증을 대신하지 않는다.


## Calculation 공유 정의·선언 계약 제거 (revision 000000000017~000000000018)

writer와 실행 작업을 중단하고 DB 백업을 확보한 뒤 새 release에서 `poetry run alembic upgrade head`를 실행합니다. API·UI·CLI를 같은 release로 배포합니다. revision 18은 CalculationSource의 선언 계약 컬럼만 제거하고 소스·해시·기존 결과·Experiment별 preflight를 보존합니다. Catalog 소스는 변경하지 않습니다. downgrade는 삭제한 컬럼을 NULL로 복원하며 계약 값은 복구하지 않습니다. revision 16의 불변 UPDATE trigger는 revision 17에서 제거되며, 애플리케이션이 소유권 및 정의 revision을 검사합니다.

같은 정의의 가장 작은 Calculation ID에서 이름·설명과 Experiment 소유자를 선택합니다. 참조 없는 정의는 소유자 없이 관리자 관리 대상으로 남깁니다. 기존 이름·설명은 `calculation_legacy_metadata`에 rollback용으로 보존합니다. 기존 코드에 계약을 추측해 추가하지 않으며, preflight 및 결과도 유지합니다. 기존 API와 새 스키마를 혼용하지 않습니다.

공유 로직 변경은 모든 연결의 결과를 무효화합니다. 운영 점검에서는 두 Experiment의 정의 ID·revision, 이름 변경의 결과 보존, 코드 변경의 모든 연결 무효화와 Experiment별 재검증을 확인합니다. 이전 revision 실행 결과가 409로 거부되는지도 확인합니다.

되돌릴 때 writer를 중단하고 새 release에서 `poetry run alembic downgrade 000000000016`을 실행한 뒤 이전 release를 복원합니다. 전환 전 이름·설명은 backup에서, 전환 후 생성된 연결은 공유 정의에서 복원합니다. 새 연결들의 이름이 이전 Experiment별 UNIQUE 제약과 충돌하면 전체 downgrade가 중단됩니다. 충돌 연결을 명시적으로 정리한 후 다시 수행하며 자동으로 연결·결과를 삭제하지 않습니다. 현재 공유 코드와 결과 무효화 이력은 이전 코드로 되돌리지 않으므로 코드 자체의 복원이 필요하면 배포 전 DB 백업을 사용합니다.

임시 PostgreSQL 검증: `RUN_CALCULATION_DB_TESTS=1`로 `tests/test_calculation_sources.py`, `tests/test_calculation_database.py`, `tests/test_experiment_calculation_copy.py`를 실행합니다. 운영 DB 적용과 Solver 실행은 별도 작업입니다.
