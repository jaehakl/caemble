from __future__ import annotations

from pathlib import Path
from socket import gethostname
from urllib.parse import urlparse, urlunparse

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


APP_ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = APP_ROOT / ".env"
DEFAULT_RTC_ICE_SERVERS_JSON = '[{"urls":"stun:stun.l.google.com:19302"}]'


class LauncherSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    api_url: str = Field(
        validation_alias=AliasChoices("CAEMBLE_API_URL", "GPSTATION_V1_API_URL"),
    )
    access_token: str = Field(
        validation_alias=AliasChoices("CAEMBLE_ACCESS_TOKEN", "GPSTATION_V1_ACCESS_TOKEN"),
    )
    launcher_name: str = Field(
        default_factory=gethostname,
        validation_alias=AliasChoices("CAEMBLE_LAUNCHER_NAME", "GPSTATION_V1_LAUNCHER_NAME"),
    )
    heartbeat_interval_seconds: float = Field(
        default=5.0,
        validation_alias=AliasChoices(
            "CAEMBLE_HEARTBEAT_INTERVAL_SECONDS",
            "GPSTATION_V1_HEARTBEAT_INTERVAL_SECONDS",
        ),
    )
    worker_ready_timeout_seconds: float = Field(
        default=10.0,
        validation_alias=AliasChoices(
            "CAEMBLE_WORKER_READY_TIMEOUT_SECONDS",
            "GPSTATION_V1_WORKER_READY_TIMEOUT_SECONDS",
        ),
    )
    rtc_ice_servers_json: str = Field(
        default=DEFAULT_RTC_ICE_SERVERS_JSON,
        validation_alias=AliasChoices(
            "CAEMBLE_RTC_ICE_SERVERS_JSON",
            "GPSTATION_V1_RTC_ICE_SERVERS_JSON",
        ),
    )
    rtc_ice_gather_timeout_seconds: str = Field(
        default="",
        validation_alias=AliasChoices(
            "CAEMBLE_RTC_ICE_GATHER_TIMEOUT_SECONDS",
            "GPSTATION_V1_RTC_ICE_GATHER_TIMEOUT_SECONDS",
        ),
    )
    rtc_memory_cache_enabled: str = Field(
        default="",
        validation_alias=AliasChoices(
            "CAEMBLE_RTC_MEMORY_CACHE_ENABLED",
            "GPSTATION_V1_RTC_MEMORY_CACHE_ENABLED",
        ),
    )

    @property
    def control_websocket_url(self) -> str:
        parsed = urlparse(self.api_url.rstrip("/"))
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("API URL must be an absolute http(s) URL")
        if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("Remote API URL must use https")
        scheme = "wss" if parsed.scheme == "https" else "ws"
        base_path = parsed.path.rstrip("/")
        path = f"{base_path}/v1/launchers/control" if base_path else "/v1/launchers/control"
        return urlunparse((scheme, parsed.netloc, path, "", "", ""))


def load_settings() -> LauncherSettings:
    return LauncherSettings()
