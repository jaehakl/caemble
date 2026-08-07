# Caemble deployment

이 문서는 Caemble FastAPI API와 Vite 정적 UI를 Ubuntu 서버에 배포한다. UI의
Code-to-CAD 실행기는 사용자 TSX를 평가하므로 메인 앱과 다른 origin에서 제공한다.

- 메인 앱: `https://www.caemble.com`
- 격리 실행기: `https://code-to-cad.caemble.com`
- FastAPI: `127.0.0.1:8000`
- 정적 웹 루트: `/var/www/caemble/current`
- 저장소: `/home/ubuntu/caemble`
- systemd 서비스: `caemble-api`
- PostgreSQL: 외부 관리형 또는 별도 서버

두 웹 origin은 동일한 `app/ui/dist` 빌드를 사용한다. 메인 origin은 SPA와
`/api/` reverse proxy를 제공하고, runner origin은 `runner.html`과 그 파일이 참조하는
해시 자산만 제공한다. UI는 로컬 Windows 개발 장비에서 build하고,
`deployment/caemble-ui.tar.gz`를 소스와 함께 Git에 commit한다. 서버에서는 Node.js나
Vite를 실행하지 않으며, `deployment/update.sh`가 최신 소스와 artifact를 함께 받아
배포한다.

## 1. DNS와 방화벽

두 `A` 레코드가 같은 서버의 고정 IP를 가리키게 한다.

```text
www.caemble.com         -> <SERVER_STATIC_IP>
code-to-cad.caemble.com -> <SERVER_STATIC_IP>
```

인터넷에는 `22`, `80`, `443`만 개방한다. FastAPI의 `8000` 포트는 Nginx 뒤의
loopback에만 바인딩한다. 외부 PostgreSQL 방화벽에는 이 서버에서 DB로 나가는 연결만
허용하고, DB를 일반 인터넷에 공개하지 않는다.

## 2. 서버 패키지

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install nginx certbot python3-certbot-nginx git python3-venv build-essential curl

curl -sSL https://install.python-poetry.org | python3 -
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

확인한다.

```bash
poetry --version
nginx -v
```

Node.js와 npm은 UI artifact를 만드는 로컬 장비에만 필요하다.

## 3. 외부 PostgreSQL 준비

대상 데이터베이스에는 PostgreSQL과 pgvector가 설치되어 있어야 한다. 예시는 다음
이름을 사용하지만 실제 계정과 비밀번호는 운영 DB 정책에 맞춘다.

```text
database: caemble
user:     caemble
extension: vector
```

초기 Alembic migration은 `CREATE EXTENSION IF NOT EXISTS vector`를 실행한다. 앱 DB
사용자에게 extension 생성 권한이 없다면 DBA가 대상 `caemble` 데이터베이스에서 먼저
다음을 실행해야 한다.

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

DB 연결은 TLS 사용을 권장한다. 공급자가 요구한다면 `DB_URL`에 `ssl=require` 등 해당
공급자의 asyncpg 연결 옵션을 포함한다. 비밀번호의 `@`, `:`, `/`, `%` 같은 문자는 URL
encoding해야 한다.

## 4. 저장소와 환경 변수

```bash
git clone <CAEMBLE_REPOSITORY_URL> /home/ubuntu/caemble
cd /home/ubuntu/caemble

cp app/api/.env.example app/api/.env
```

`app/api/.env`를 운영값으로 채운다.

```dotenv
DB_URL=postgresql+asyncpg://caemble:<URL_ENCODED_PASSWORD>@<DB_HOST>:5432/caemble

GOOGLE_CLIENT_ID=<GOOGLE_CLIENT_ID>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<GOOGLE_CLIENT_SECRET>
GOOGLE_REDIRECT_URI=https://www.caemble.com/api/auth/google/callback

APP_BASE_URL=https://www.caemble.com
PUBLIC_API_BASE_URL=https://www.caemble.com/api
ALLOWED_APP_ORIGINS=https://www.caemble.com
APP_TIMEZONE=Asia/Seoul
OAUTH_STATE_TTL_SEC=600
CSRF_TTL_SEC=3600

JWT_SECRET=<AT_LEAST_32_RANDOM_BYTES>

# 빈 값은 www.caemble.com의 host-only 쿠키를 만든다. .caemble.com으로 설정하지 않는다.
COOKIE_DOMAIN=
SECURE_COOKIES=true
```

JWT secret은 다음과 같이 생성할 수 있다.

```bash
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
```

`COOKIE_DOMAIN`을 비워 두는 것은 필수 보안 경계다. `.caemble.com`을 설정하면 인증 쿠키가
`code-to-cad.caemble.com`에도 전달될 수 있다.

UI의 세 환경 변수는 로컬 build shell에서 설정한다. Vite build 시점에 번들에
포함되므로 변경 후에는 새 artifact를 만들어 다시 배포해야 한다.

```dotenv
VITE_API_BASE_URL=/api
VITE_CAEMBLE_HOST_ORIGIN=https://www.caemble.com
VITE_CAEMBLE_RUNNER_ORIGIN=https://code-to-cad.caemble.com
```

실제 API `.env` 파일은 commit하지 않는다. 서버에는 UI `.env` 파일을 만들지 않는다.

Google Cloud Console의 OAuth client에는 다음 값만 추가한다.

- Authorized JavaScript origin: `https://www.caemble.com`
- Authorized redirect URI: `https://www.caemble.com/api/auth/google/callback`

runner origin에는 OAuth origin이나 redirect URI를 등록하지 않는다.

## 5. 로컬 UI build와 최초 release

로컬 장비에는 Node.js와 npm, `tar`가 필요하다. 현재 dependency의 지원 범위에 맞는
Node.js 22.13 LTS 또는 Node.js 24 이상을 권장한다. 실행 중인 Caemble UI 개발 서버를
종료한 뒤 다음 배치 파일을 실행한다.

```powershell
cd E:\caemble
deployment\build-ui.bat
```

배치 파일은 시작할 때 기존 `deployment\caemble-ui.tar.gz`를 삭제한다. SDK/UI
dependency 설치와 production build가 모두 성공하고 `index.html`, `runner.html`,
production asset 검사를 통과한 경우에만 같은 경로에 새 artifact를 만든다. production
UI 환경 변수도 배치 파일이 설정하므로 로컬 `.env`를 배포용으로 바꿀 필요가 없다.

`npm run build`가 검사하는 주요 조건은 다음과 같다.

- `runner.html`과 배포 header의 runner CSP 일치
- runner Worker 밖에 `new Function`이 없는지 확인
- 금지된 CDN/WASM runtime 의존성 확인
- 생성된 CAD API와 고정된 Monaco/API 버전 확인

artifact를 관련 소스 변경과 같은 commit에 포함해 push한다.

```powershell
git add deployment\caemble-ui.tar.gz
# 관련 소스 파일도 같은 commit에 stage한다.
git commit
git push
```

최초 전환 시에는 서버에 아직 이전 `update.sh`가 있으므로 한 번만 직접 pull한 뒤 새
스크립트를 실행한다.

```bash
cd /home/ubuntu/caemble
git pull --ff-only
bash deployment/update.sh
```

새 서버에서 처음 배포할 때도 같은 명령을 사용한다. 이 시점에 systemd 서비스가 아직
설치되지 않았다면 API 재시작만 건너뛰며, 6절에서 서비스를 설치하고 시작한다.

## 6. systemd API 서비스

`/etc/systemd/system/caemble-api.service`를 만든다.

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

`WorkingDirectory`가 `api/app`인 이유는 현재 API module이 `main:app`과 같은 app-local
import 계약을 사용하기 때문이다. launcher WebSocket registry가 프로세스 메모리에
있으므로 `--workers`를 추가하거나 같은 API를 여러 replica로 띄우면 안 된다.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now caemble-api
sudo systemctl status caemble-api --no-pager
curl -fsS http://127.0.0.1:8000/openapi.json >/dev/null
```

현재 API에는 별도 `/health` route가 없으므로 `/openapi.json`을 기본 프로세스 smoke
check로 사용한다.

### 사용자 launcher 설치

각 사용자는 Account에서 `launcher` 용도의 token을 새로 만들고, worker를 실행할
장비에 Caemble checkout을 준비한다. 사용할 slave만 설치하면 launcher가 해당
`manifest.json`을 자동 발견한다.

```bash
cd /opt/caemble/app/slaves/cae
poetry install

cd /opt/caemble/app/slaves/ai
cp models.example.toml models.toml
# 장비에 실제로 존재하는 LLM, SDXL, embedding catalog와 경로로 수정한다.
poetry install

cd /opt/caemble/app/launcher
cp env.example .env
```

launcher의 `.env`에는 다음 두 값을 설정한다. 운영 URL에는 외부 reverse-proxy
prefix인 `/api`가 반드시 포함되어야 한다.

```dotenv
CAEMBLE_API_URL=https://www.caemble.com/api
CAEMBLE_ACCESS_TOKEN=<ONE_TIME_DISPLAYED_LAUNCHER_TOKEN>
```

```bash
cd /opt/caemble/app/launcher
poetry install
poetry run launcher
```

한 launcher는 worker와 job을 한 번에 하나만 실행한다. 같은 사용자가 병렬 job을
실행하려면 별도 장비나 별도 checkout에서 launcher를 추가한다. `models.toml`, 모델
가중치, Hugging Face cache, `.env`, `.venv`, VOICEVOX runtime은 장비 로컬 상태이며
배포 저장소나 중앙 API로 복사하지 않는다. 기존 `GPSTATION_V1_*` 환경변수도 전환
기간의 fallback alias로만 지원한다.

## 7. 최초 인증서 발급과 Nginx

최종 `app.conf`는 다음 인증서 파일을 참조한다.

```text
/etc/letsencrypt/live/www.caemble.com/fullchain.pem
/etc/letsencrypt/live/www.caemble.com/privkey.pem
```

인증서가 생기기 전에 최종 설정을 활성화하면 `nginx -t`가 실패한다. 먼저 임시
HTTP-only 사이트를 만든다.

```bash
sudo mkdir -p /var/www/letsencrypt
sudo tee /etc/nginx/sites-available/caemble-bootstrap.conf >/dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name www.caemble.com code-to-cad.caemble.com;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }

    location / {
        return 200 "caemble bootstrap\n";
    }
}
EOF

sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sfn /etc/nginx/sites-available/caemble-bootstrap.conf /etc/nginx/sites-enabled/caemble-bootstrap.conf
sudo nginx -t
sudo systemctl reload nginx

sudo certbot certonly --nginx \
  -d www.caemble.com \
  -d code-to-cad.caemble.com
```

`www.caemble.com`을 첫 번째 SAN 이름으로 발급해야 저장소의 `app.conf`에 적힌 인증서
경로와 일치한다. 발급 후 최종 설정으로 교체한다.

```bash
sudo cp /home/ubuntu/caemble/deployment/app.conf /etc/nginx/sites-available/caemble.conf
sudo rm -f /etc/nginx/sites-enabled/caemble-bootstrap.conf
sudo ln -sfn /etc/nginx/sites-available/caemble.conf /etc/nginx/sites-enabled/caemble.conf
sudo nginx -t
sudo systemctl reload nginx
```

최종 설정은 다음 보안 경계를 유지한다.

- `www.caemble.com/api/*`만 FastAPI로 전달하고 외부 `/api/` prefix는 제거한다.
- `/api/`는 WebSocket upgrade를 전달하고 job/launcher 장기 연결에 3,600초 timeout을
  적용한다.
- 메인 CSP는 `code-to-cad.caemble.com`만 frame으로 허용하며 `'unsafe-eval'`을 허용하지 않는다.
- runner CSP는 코드의 production 검사와 동일한 값이며 `connect-src 'none'`을 유지한다.
- runner origin의 `/`와 `/api/*`는 `404`이며 쿠키나 일반 앱 route를 제공하지 않는다.
- 메인 origin의 `/runner.html`도 `404`로 차단한다.

인증서 자동 갱신을 확인한다.

```bash
sudo certbot renew --dry-run
```

## 8. 배포 확인

```bash
curl -I https://www.caemble.com/
curl -I https://www.caemble.com/viewer
curl -fsS https://www.caemble.com/api/openapi.json >/dev/null

test "$(curl -sS -o /dev/null -w '%{http_code}' https://www.caemble.com/api/auth/me)" = "401"
test "$(curl -sS -o /dev/null -w '%{http_code}' https://code-to-cad.caemble.com/)" = "404"
test "$(curl -sS -o /dev/null -w '%{http_code}' https://code-to-cad.caemble.com/api/openapi.json)" = "404"

curl -sSI https://code-to-cad.caemble.com/runner.html
curl -I "https://www.caemble.com/api/auth/google/start?return_to=https%3A%2F%2Fwww.caemble.com%2Faccount"

sudo systemctl status caemble-api --no-pager
sudo nginx -t
```

확인 기준은 다음과 같다.

- `/`와 `/viewer`는 `200`을 반환하고 새로고침해도 SPA가 열린다.
- `/api/openapi.json`은 FastAPI schema를 반환한다.
- 비로그인 `/api/auth/me`는 예상된 `401`을 반환한다.
- runner의 `/runner.html`만 `200`이며 정확한 CSP와 `Cache-Control: no-store`가 있다.
- Google OAuth 시작 route는 Google로 redirect하고 callback 후 `www.caemble.com`으로 돌아온다.
- 브라우저 Viewer에서 runner iframe이 로드되고 TSX preview가 실행된다.
- 브라우저에 CSP, cross-origin, cookie 경고가 없다.

## 9. 이후 업데이트

로컬에서 UI artifact를 만들고 소스 변경과 함께 commit/push한다.

```powershell
cd E:\caemble
deployment\build-ui.bat
git add deployment\caemble-ui.tar.gz
# 관련 소스 파일도 같은 commit에 stage한다.
git commit
git push
```

서버에서는 다음 명령 하나만 실행한다.

```bash
cd /home/ubuntu/caemble
bash deployment/update.sh
```

`update.sh`는 `git pull --ff-only`로 최신 소스와 artifact를 함께 받은 뒤 archive
무결성과 `index.html`, `runner.html`을 먼저 검사한다. 검사가 끝난 후에만 API
dependency 설치, Alembic migration, 새 정적 release 게시, `current` 링크 원자적 교체,
API 재시작, Nginx 검사/reload를 수행한다. Git 추적 파일인 artifact는 배포 후에도
삭제하거나 수정하지 않는다.

기존 release는 자동 삭제하지 않는다. 디스크 사용량을 확인한 뒤 현재 링크와 직전
release를 제외하고 운영자가 정리한다.

## 10. 로그, 장애 확인, 롤백

API가 뜨지 않으면 다음 순서로 확인한다.

```bash
sudo journalctl -u caemble-api -n 100 --no-pager
sudo systemctl status caemble-api --no-pager
curl -v http://127.0.0.1:8000/openapi.json
cd /home/ubuntu/caemble/app/api
poetry run alembic current
```

Nginx 또는 정적 파일 문제가 있으면 확인한다.

```bash
readlink -f /var/www/caemble/current
ls -la /var/www/caemble/current/
sudo -u www-data test -r /var/www/caemble/current/index.html && echo "index readable"
sudo nginx -t
sudo tail -n 100 /var/log/nginx/caemble-error.log
sudo tail -n 100 /var/log/nginx/caemble-runner-error.log
```

UI만 긴급 롤백할 때는 기존 release를 확인한 뒤 `current` 링크를 원자적으로 바꾼다.

```bash
ls -1 /var/www/caemble/releases
PREVIOUS_RELEASE=<PREVIOUS_RELEASE_DIRECTORY>
sudo ln -sfn "/var/www/caemble/releases/$PREVIOUS_RELEASE" /var/www/caemble/.rollback-current
sudo mv -Tf /var/www/caemble/.rollback-current /var/www/caemble/current
```

API 코드 롤백은 운영 branch에서 문제 commit을 `git revert`한 후 9절의 로컬
artifact build와 서버 update를 다시 실행한다. 이미 적용한 DB migration은 임의로
`alembic downgrade`하지 않는다. schema 호환이 깨진 migration이라면 사전에 준비한
DB snapshot을 복원하거나 검토된 보정 migration을 적용한다.

## 11. 전환 순서

1. Caemble schema/API와 WebSocket proxy를 배포한다.
2. client token importer를 dry-run한 뒤 오류가 없을 때만 `--apply`한다.
3. 사용자별 Caemble `launcher` token을 발급하고 launcher 연결을 확인한다.
4. 원본 v1 SDK로 launcher 조회, CAE job, AI model 조회와 streaming chat smoke를 한다.
5. 외부 client의 token은 그대로 두고 base URL만
   `https://www.caemble.com/api`로 바꾼다.
6. 전환 검증 후 source DB 환경 변수와 접근 권한을 제거하고, 운영 정책에 맞춰 기존
   GPStation token을 만료하거나 폐기한다.
