from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from settings import settings


def app_timezone() -> timezone | ZoneInfo:
    try:
        return ZoneInfo(settings.app_timezone)
    except ZoneInfoNotFoundError:
        return timezone.utc


def to_utc_datetime(
    value: datetime,
    *,
    naive_timezone: timezone | ZoneInfo | None = None,
) -> datetime:
    if value.tzinfo is None:
        value = value.replace(tzinfo=naive_timezone or app_timezone())
    return value.astimezone(timezone.utc)


def parse_api_datetime_to_utc(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return to_utc_datetime(value)
    if not isinstance(value, str):
        return None

    stripped_value = value.strip()
    if not stripped_value:
        return None

    try:
        parsed_value = datetime.fromisoformat(stripped_value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return to_utc_datetime(parsed_value)


def db_datetime_to_utc(value: datetime) -> datetime:
    return to_utc_datetime(value, naive_timezone=timezone.utc)


def utc_isoformat(value: datetime) -> str:
    return db_datetime_to_utc(value).isoformat().replace("+00:00", "Z")


def serialize_datetime_utc(value: Any) -> Any:
    if isinstance(value, datetime):
        return utc_isoformat(value)
    if isinstance(value, list):
        return [serialize_datetime_utc(item) for item in value]
    if isinstance(value, tuple):
        return [serialize_datetime_utc(item) for item in value]
    if isinstance(value, dict):
        return {
            key: serialize_datetime_utc(item)
            for key, item in value.items()
        }
    return value
