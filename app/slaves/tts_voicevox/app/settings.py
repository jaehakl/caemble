from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


APP_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(APP_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    voicevox_runtime_dir: str = "voicevox_runtime"
    voicevox_cpu_num_threads: int = Field(default=0, ge=0, le=65535)

    def resolve_app_path(self, value: str) -> Path:
        path = Path(value).expanduser()
        return path if path.is_absolute() else APP_DIR / path


settings = Settings()
