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

`app/api/.env.example`을 `app/api/.env`로 복사하고 PostgreSQL, Google OAuth, JWT,
cookie 설정을 운영값으로 설정한다. 인증 cookie가 runner origin으로
전달되지 않도록 `COOKIE_DOMAIN`은 비워 둔다.

PostgreSQL에는 pgvector가 있어야 한다. baseline migration이 extension과 application
table, 기본 user/admin role을 만든다.

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

스크립트는 `git fetch` 후 upstream commit을 고정하고, 해당 commit의 drain 검사기·Nginx 설정·웹
artifact를 임시 디렉터리에 준비한다. 이때 실행 중인 checkout의 코드와 canonical Catalog는 변경하지
않는다. Nginx admission gate를 설치하여 신규 배치·retry·commit을 잠시 차단하며 조회·SSE와 worker
연결은 유지한다. 임시 `check-cae-drain.py`를 기존 API Poetry 환경과 명시한 `app/api/.env`로 실행하여
활성 배치와 worker cleanup을 확인한다. 기본 300초 안에 완료되지 않으면 기존 Nginx 설정을 복구하고
gate를 해제한다. 기존 API와 checkout은 그대로 유지된다.
`CAE_DRAIN_TIMEOUT_SECONDS`로 대기 시간을 조정한다. 미완료 업로드는 전환 전에 취소한다.

검사 통과 후에만 API를 정지하고, 고정한 commit으로 fast-forward하여 API와 Catalog를 함께 전환한다.
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
