"""Read-only release gate; run using the API Poetry environment after closing admissions."""

import argparse
import asyncio
import os
import time
from pathlib import Path

import asyncpg
from dotenv import load_dotenv
from sqlalchemy.engine import make_url


async def main(env_path: Path) -> None:
    load_dotenv(env_path)
    url = make_url(os.environ["DB_URL"])
    connection = await asyncpg.connect(user=url.username, password=url.password,
        host=url.host, port=url.port, database=url.database)
    try:
        if not await connection.fetchval("SELECT to_regclass('job_batches')"):
            print("No legacy batches: release gate passed.")
            return
        deadline = time.monotonic() + int(os.getenv("CAE_DRAIN_TIMEOUT_SECONDS", "300"))
        while True:
            count = await connection.fetchval(
                "SELECT count(*) FROM job_batches WHERE state IN ('uploading', 'queued', 'running')"
            )
            cleanup = await connection.fetchval(
                "SELECT count(*) FROM jobs WHERE job_mode = 'websocket' "
                "AND launcher_id IS NOT NULL AND cleaned_at IS NULL"
            )
            if count == 0 and cleanup == 0:
                print("CAE batches and worker cleanup drained: release gate passed.")
                return
            if time.monotonic() >= deadline:
                raise SystemExit(f"Release aborted: {count} active batches, {cleanup} workers awaiting cleanup. Existing API remains running.")
            print(f"Waiting for {count} active batches and {cleanup} worker cleanups.", flush=True)
            await asyncio.sleep(2)
    finally:
        await connection.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", type=Path, default=Path(__file__).resolve().parents[1] / "app/api/.env")
    asyncio.run(main(parser.parse_args().env))
