from __future__ import annotations

import json
import os
from collections.abc import Iterator
from typing import Any

RTC_ICE_SERVERS_ENV = "GPSTATION_V1_RTC_ICE_SERVERS_JSON"
RTC_ICE_GATHER_TIMEOUT_ENV = "GPSTATION_V1_RTC_ICE_GATHER_TIMEOUT_SECONDS"
RTC_MEMORY_CACHE_ENABLED_ENV = "GPSTATION_V1_RTC_MEMORY_CACHE_ENABLED"
DEFAULT_RTC_ICE_SERVERS = [{"urls": "stun:stun.l.google.com:19302"}]
DEFAULT_STUN_ICE_GATHER_TIMEOUT_SECONDS = 1.0
DEFAULT_TURN_ICE_GATHER_TIMEOUT_SECONDS = 5.0


def build_rtc_configuration(
    rtc_configuration_cls: Any,
    rtc_ice_server_cls: Any,
    ice_servers: list[dict[str, Any]] | None = None,
) -> Any:
    servers = ice_servers if ice_servers is not None else load_rtc_ice_servers()
    return rtc_configuration_cls(
        iceServers=[
            rtc_ice_server_cls(**ice_server_kwargs(item))
            for item in servers
        ]
    )


def load_rtc_ice_servers() -> list[dict[str, Any]]:
    raw_value = os.environ.get(RTC_ICE_SERVERS_ENV, "").strip()
    if not raw_value:
        return [dict(item) for item in DEFAULT_RTC_ICE_SERVERS]
    try:
        parsed = json.loads(raw_value)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{RTC_ICE_SERVERS_ENV} must be valid JSON: {exc.msg}") from exc
    return validate_rtc_ice_servers(parsed)


def load_rtc_ice_gather_timeout_seconds(ice_servers: list[dict[str, Any]]) -> float:
    raw_value = os.environ.get(RTC_ICE_GATHER_TIMEOUT_ENV, "").strip()
    if raw_value:
        try:
            timeout_seconds = float(raw_value)
        except ValueError as exc:
            raise ValueError(f"{RTC_ICE_GATHER_TIMEOUT_ENV} must be a positive number") from exc
        if timeout_seconds <= 0:
            raise ValueError(f"{RTC_ICE_GATHER_TIMEOUT_ENV} must be a positive number")
        return timeout_seconds
    if any(url.startswith(("turn:", "turns:")) for url in iter_rtc_ice_server_urls(ice_servers)):
        return DEFAULT_TURN_ICE_GATHER_TIMEOUT_SECONDS
    return DEFAULT_STUN_ICE_GATHER_TIMEOUT_SECONDS


def load_rtc_memory_cache_enabled() -> bool:
    raw_value = os.environ.get(RTC_MEMORY_CACHE_ENABLED_ENV, "").strip().lower()
    if not raw_value:
        return True
    if raw_value in {"1", "true", "yes", "on"}:
        return True
    if raw_value in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{RTC_MEMORY_CACHE_ENABLED_ENV} must be true or false")


def configure_aioice_gather_timeout(aioice_connection_cls: Any, timeout_seconds: float) -> None:
    original = getattr(aioice_connection_cls, "_caemble_original_get_component_candidates", None)
    if original is None:
        original = aioice_connection_cls.get_component_candidates
        setattr(aioice_connection_cls, "_caemble_original_get_component_candidates", original)

    async def get_component_candidates(self: Any, component: int, addresses: list[str], timeout: float = 5) -> Any:
        effective_timeout = timeout_seconds if timeout == DEFAULT_TURN_ICE_GATHER_TIMEOUT_SECONDS else timeout
        return await original(self, component=component, addresses=addresses, timeout=effective_timeout)

    aioice_connection_cls.get_component_candidates = get_component_candidates
    setattr(aioice_connection_cls, "_caemble_ice_gather_timeout_seconds", timeout_seconds)


def validate_rtc_ice_servers(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValueError(f"{RTC_ICE_SERVERS_ENV} must be a JSON array")
    servers: list[dict[str, Any]] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise ValueError(f"{RTC_ICE_SERVERS_ENV}[{index}] must be an object")
        urls = item.get("urls")
        if not (isinstance(urls, str) or is_string_list(urls)):
            raise ValueError(f"{RTC_ICE_SERVERS_ENV}[{index}].urls must be a string or string array")
        server = {"urls": urls}
        for key in ("username", "credential", "credentialType"):
            optional_value = item.get(key)
            if optional_value is None:
                continue
            if not isinstance(optional_value, str):
                raise ValueError(f"{RTC_ICE_SERVERS_ENV}[{index}].{key} must be a string")
            server[key] = optional_value
        servers.append(server)
    return servers


def ice_server_kwargs(server: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in server.items() if key in {"urls", "username", "credential", "credentialType"}}


def is_string_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def iter_rtc_ice_server_urls(ice_servers: list[dict[str, Any]]) -> Iterator[str]:
    for server in ice_servers:
        urls = server.get("urls")
        items = urls if isinstance(urls, list) else [urls]
        for item in items:
            if isinstance(item, str):
                yield item.lower()
