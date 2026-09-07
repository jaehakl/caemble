# Caemble deployment

Caemble은 Ubuntu의 FastAPI 서비스와 정적 Vite UI로 배포한다. 사용자 CAD 코드를 실행하는
runner는 메인 앱과 다른 origin에서 제공한다. 서버의 CAE 입력 생성은 별도 Node child에서
실행하므로 API 호스트에 Node.js 22.13 이상이 필요하다.

- 메인 앱: `https://www.caemble.com`
- runner: `https://code-to-cad.caemble.com`
- FastAPI: `127.0.0.1:8000`
- 정적 루트: `/var/www/caemble/current`
- 저장소: `/home/ubuntu/caemble`

## API 환경

`app/api/.env.example`을 `app/api/.env`로 복사하고 PostgreSQL, Google OAuth, JWT,
cookie, AI credential 암호화 키를 운영값으로 설정한다. 인증 cookie가 runner origin으로
전달되지 않도록 `COOKIE_DOMAIN`은 비워 둔다.

PostgreSQL에는 pgvector가 있어야 한다. baseline migration이 extension과 application
table, 기본 user/admin role을 만든다.

## UI artifact

Windows checkout에서 다음을 실행한다.

```powershell
cd E:\caemble
deployment\build-ui.bat
```

이 명령은 JavaScript SDK를 build하고 UI의 TypeScript build와 Vite production build를
실행하고 서버 입력 생성기를 build한 뒤 다음 두 artifact를 만든다. artifact와 관련 source를
같은 commit에 포함한다.

- `deployment/caemble-ui.tar.gz`: 웹 UI와 격리된 browser runner
- `deployment/caemble-cae-preparation.tar.gz`: `prepare.cjs`와 TypeScript 선언 파일

서버 입력 생성기는 `app/ui/dist-cae`에 설치되며 서버에는 `node_modules`가 필요 없다.
개발 환경에서는 `app/ui`에서 `npm run build:cae-preparation`을 실행한다.
`node app/ui/dist-cae/prepare.cjs --check`로 Node 버전과 선언 파일을 확인할 수 있다.

API 설정은 `CAE_NODE_EXECUTABLE`(기본 `node`), `CAE_PREPARATION_SCRIPT`(기본
`app/ui/dist-cae/prepare.cjs`), `CAE_PREPARATION_CONCURRENCY`(기본 `1`)이다.
입력 생성 child에는 DB 인증 정보나 launcher token을 전달하지 않는다. Node permission mode는
artifact 디렉터리 읽기만 허용하고 파일 쓰기와 child process 생성을 차단한다. VM 시간 제한과
source policy는 OS sandbox가 아니므로 운영 계정의 파일·네트워크 권한은 필요한 범위로 제한한다.

## 서버 배치 실행 전환

기존 데이터는 유지하고 일반 Alembic migration을 적용한다. 이번 전환에서는
`RESET_API_SCHEMA`를 사용하지 않는다. API·UI·Launcher·CAE를 동일 commit으로 전환한다.

```bash
bash deployment/update.sh
```

스크립트는 Node와 두 artifact를 먼저 확인하고 API를 정지한 뒤 입력 생성기, API dependency와
migration을 적용한다. UI release symlink를 원자적으로 바꾸고 API와 Nginx를 다시 올린다.
서버 재시작으로 중단된 실행은 실패로 남으며 미시작 배치 항목은 계속 처리한다. 실패 항목은
사용자가 수동 재시도한다.

## systemd

API는 한 프로세스로 실행한다. launcher registry와 진행 중 Agent session이 process memory에
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
