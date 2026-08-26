# Caemble deployment

Caemble은 Ubuntu의 FastAPI 서비스와 정적 Vite UI로 배포한다. 사용자 CAD 코드를 실행하는
runner는 메인 앱과 다른 origin에서 제공한다.

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
실행한 뒤 `deployment/caemble-ui.tar.gz`를 만든다. artifact와 관련 source를 같은 commit에
포함한다.

## destructive schema cutover

이번 baseline 전환에서는 기존 application schema를 그대로 삭제하고 다시 만든다. 백업,
이전 row 변환, 호환 alias는 실행하지 않는다.

```bash
cd /home/ubuntu/caemble
git pull --ff-only
RESET_API_SCHEMA=1 bash deployment/update.sh
```

`RESET_API_SCHEMA=1`은 `public` schema와 Alembic 이력을 삭제하고 새 baseline을 적용한다.
이후 일반 배포에는 변수를 주지 않는다.

```bash
bash deployment/update.sh
```

스크립트는 API dependency와 migration을 적용하고 UI release symlink를 원자적으로 바꾼 뒤
API와 Nginx를 다시 올린다.

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

## launcher 재등록

schema reset 뒤에는 기존 launcher access key가 존재하지 않는다. 먼저 브라우저에서 Google
OAuth로 로그인하고 Account에서 launcher 용도의 새 token을 직접 발급한다. worker 장비의
`app/launcher/.env`에는 다음 값만 둔다.

```dotenv
CAEMBLE_API_URL=https://www.caemble.com/api
CAEMBLE_ACCESS_TOKEN=<NEW_LAUNCHER_TOKEN>
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
