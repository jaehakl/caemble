"""Explicitly erase and recreate the API's PostgreSQL application schema."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
import sys

from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine


API_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(API_DIR / "app"))

from db import make_async_db_url  # noqa: E402
from settings import settings  # noqa: E402


async def drop_public_schema() -> None:
    engine = create_async_engine(make_async_db_url(settings.db_url))
    try:
        async with engine.begin() as connection:
            await connection.execute(text("DROP SCHEMA public CASCADE"))
            await connection.execute(text("CREATE SCHEMA public AUTHORIZATION CURRENT_USER"))
    finally:
        await engine.dispose()


def main() -> None:
    if os.getenv("RESET_API_SCHEMA") != "1":
        raise RuntimeError("Set RESET_API_SCHEMA=1 to erase and recreate the public schema")
    asyncio.run(drop_public_schema())
    command.upgrade(Config(str(API_DIR / "alembic.ini")), "head")


if __name__ == "__main__":
    main()
