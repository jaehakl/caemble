from pathlib import Path

import pytest

from app.settings import LauncherSettings


def test_launcher_settings_env_file_is_launcher_app_root_dotenv():
    assert Path(LauncherSettings.model_config["env_file"]) == Path(__file__).resolve().parents[1] / ".env"
    assert LauncherSettings.model_config["env_file_encoding"] == "utf-8"


def test_launcher_settings_reads_legacy_values_from_env_file(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "\n".join(
            [
                "GPSTATION_V1_API_URL=http://127.0.0.1:8199/base/",
                "GPSTATION_V1_ACCESS_TOKEN=test-launcher-token",
                'GPSTATION_V1_RTC_ICE_SERVERS_JSON=[{"urls":"stun:example.com:3478"}]',
                "GPSTATION_V1_RTC_ICE_GATHER_TIMEOUT_SECONDS=1.5",
                "GPSTATION_V1_RTC_MEMORY_CACHE_ENABLED=false",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.delenv("GPSTATION_V1_API_URL", raising=False)
    monkeypatch.delenv("GPSTATION_V1_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("CAEMBLE_API_URL", raising=False)
    monkeypatch.delenv("CAEMBLE_ACCESS_TOKEN", raising=False)
    monkeypatch.setitem(LauncherSettings.model_config, "env_file", str(env_file))

    settings = LauncherSettings()

    assert settings.api_url == "http://127.0.0.1:8199/base"
    assert settings.access_token == "test-launcher-token"
    assert settings.rtc_ice_servers_json == '[{"urls":"stun:example.com:3478"}]'
    assert settings.rtc_ice_gather_timeout_seconds == "1.5"
    assert settings.rtc_memory_cache_enabled == "false"


def test_caemble_environment_values_take_priority_over_legacy_values(monkeypatch):
    monkeypatch.setenv("CAEMBLE_API_URL", "http://127.0.0.1:8200/caemble/")
    monkeypatch.setenv("CAEMBLE_ACCESS_TOKEN", "caemble-token")
    monkeypatch.setenv("CAEMBLE_LAUNCHER_NAME", "caemble-launcher")
    monkeypatch.setenv("CAEMBLE_RTC_ICE_GATHER_TIMEOUT_SECONDS", "2.5")
    monkeypatch.setenv("GPSTATION_V1_API_URL", "http://127.0.0.1:8199/legacy")
    monkeypatch.setenv("GPSTATION_V1_ACCESS_TOKEN", "legacy-token")
    monkeypatch.setenv("GPSTATION_V1_LAUNCHER_NAME", "legacy-launcher")
    monkeypatch.setenv("GPSTATION_V1_RTC_ICE_GATHER_TIMEOUT_SECONDS", "1.0")

    settings = LauncherSettings(_env_file=None)

    assert settings.api_url == "http://127.0.0.1:8200/caemble"
    assert settings.access_token == "caemble-token"
    assert settings.launcher_name == "caemble-launcher"
    assert settings.rtc_ice_gather_timeout_seconds == "2.5"


def test_control_websocket_url_uses_v1_path():
    settings = LauncherSettings(api_url="http://127.0.0.1:8000/", access_token="test-token")

    assert settings.control_websocket_url == "ws://127.0.0.1:8000/v1/launchers/control"


def test_https_api_url_uses_wss():
    settings = LauncherSettings(api_url="https://gps.example.com/base", access_token="test-token")

    assert settings.control_websocket_url == "wss://gps.example.com/base/v1/launchers/control"


@pytest.mark.parametrize("api_url", ["http://gps.example.com", "ftp://gps.example.com", "htps://gps.example.com"])
def test_remote_or_invalid_api_url_cannot_downgrade_bearer_websocket(api_url):
    with pytest.raises(ValueError):
        LauncherSettings(api_url=api_url, access_token="test-token")


def test_launcher_settings_requires_access_token(monkeypatch):
    monkeypatch.delenv("CAEMBLE_ACCESS_TOKEN", raising=False)
    monkeypatch.setenv("GPSTATION_V1_API_URL", "http://127.0.0.1:8000")
    monkeypatch.delenv("GPSTATION_V1_ACCESS_TOKEN", raising=False)

    try:
        LauncherSettings(_env_file=None)
    except Exception as exc:
        assert "CAEMBLE_ACCESS_TOKEN" in str(exc)
    else:
        raise AssertionError("LauncherSettings should require a Caemble or legacy access token")


def test_launcher_settings_requires_api_url(monkeypatch):
    monkeypatch.delenv("CAEMBLE_API_URL", raising=False)
    monkeypatch.delenv("GPSTATION_V1_API_URL", raising=False)
    monkeypatch.setenv("GPSTATION_V1_ACCESS_TOKEN", "test-launcher-token")

    try:
        LauncherSettings(_env_file=None)
    except Exception as exc:
        assert "CAEMBLE_API_URL" in str(exc)
    else:
        raise AssertionError("LauncherSettings should require a Caemble or legacy API URL")
