import os

from dotenv import load_dotenv
from pydantic import BaseModel

load_dotenv()


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def env_csv(name: str, default: str) -> tuple[str, ...]:
    return tuple(value.strip().rstrip("/") for value in os.getenv(name, default).split(",") if value.strip())


class Settings(BaseModel):
    db_url: str = os.getenv("DB_URL", "")
    google_client_id: str = os.getenv("GOOGLE_CLIENT_ID", "")
    google_client_secret: str = os.getenv("GOOGLE_CLIENT_SECRET", "")
    google_redirect_uri: str = os.getenv("GOOGLE_REDIRECT_URI", "")
    google_id_token_clock_skew_sec: int = int(os.getenv("GOOGLE_ID_TOKEN_CLOCK_SKEW_SEC", "10"))

    app_base_url: str = os.getenv("APP_BASE_URL", "http://localhost:5173").rstrip("/")
    public_api_base_url: str = os.getenv("PUBLIC_API_BASE_URL", "http://localhost:8000").rstrip("/")
    allowed_app_origins: tuple[str, ...] = env_csv(
        "ALLOWED_APP_ORIGINS",
        "http://localhost:5173",
    )
    app_timezone: str = os.getenv("APP_TIMEZONE", "Asia/Seoul")
    oauth_state_ttl_sec: int = int(os.getenv("OAUTH_STATE_TTL_SEC", "600"))

    JWT_SECRET: str = os.getenv("JWT_SECRET", "")
    JWT_ALG: str = "HS256"
    ACCESS_TTL_SEC: int = 1200
    REFRESH_TTL_SEC: int = 60 * 60 * 24 * 14
    CSRF_TTL_SEC: int = int(os.getenv("CSRF_TTL_SEC", "3600"))
    COOKIE_DOMAIN: str = os.getenv("COOKIE_DOMAIN", "")
    SECURE_COOKIES: bool = env_bool("SECURE_COOKIES", True)


settings = Settings()
