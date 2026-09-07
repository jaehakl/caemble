from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from pathlib import Path

from sqlalchemy import and_, exists, or_, select

from cae.db import CaeBatch
from db import Measurement, SessionLocal
from gpstation.db import Job, JobBatch
from gpstation.service.batches import add_event, finish_job, serialize_events
from gpstation.service.state import utcnow
from settings import settings

logger = logging.getLogger(__name__)


def run_preparation_child(spec: dict, cancelled: threading.Event) -> dict:
    artifact = Path(settings.cae_preparation_script).resolve()
    if not artifact.is_file():
        raise RuntimeError(
            "CAE preparation artifact is missing. Run npm run build:cae-preparation in app/ui."
        )
    env = {
        key: value
        for key, value in os.environ.items()
        if key.upper()
        in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"}
    }
    # communicate() can block writing stdin on Windows; monitoring stays independent.
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="cae-preparation-io") as io:
        process = subprocess.Popen(
            [
                settings.cae_node_executable,
                "--permission",
                f"--allow-fs-read={artifact.parent}",
                str(artifact),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=artifact.parent,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        try:
            timeout = 60 + spec["evaluation_timeout_ms"] / 1000
            deadline = time.monotonic() + timeout
            payload = json.dumps(spec, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            communication = io.submit(process.communicate, payload)
            while True:
                if cancelled.is_set():
                    raise RuntimeError("CAE preparation cancelled.")
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"CAE preparation exceeded {timeout:g} seconds.")
                try:
                    stdout, stderr = communication.result(
                        timeout=min(0.2, max(0.001, deadline - time.monotonic()))
                    )
                    break
                except TimeoutError:
                    if communication.done():
                        stdout, stderr = communication.result()
                        break
            result = json.loads(stdout.decode("utf-8")) if stdout else {}
            if not isinstance(result, dict):
                raise ValueError("CAE preparation response must be an object.")
            if process.returncode or "error" in result:
                raise RuntimeError(
                    result.get("error", {}).get("message")
                    or stderr.decode("utf-8", errors="replace")[-4000:]
                    or "CAE preparation failed."
                )
            for field in ("measurement", "vars", "material_parameters"):
                if not isinstance(result.get(field), dict):
                    raise ValueError(f"CAE preparation returned invalid {field}.")
            return result
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()


async def prepare_input(spec: dict) -> dict:
    cancelled = threading.Event()
    task = asyncio.create_task(asyncio.to_thread(run_preparation_child, spec, cancelled))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        cancelled.set()
        # Repeated cancellation must not return a preparation slot before reaping Node.
        while not task.done():
            with suppress(asyncio.CancelledError, Exception):
                await asyncio.shield(task)
        if not task.cancelled():
            task.exception()
        raise


class PreparationQueue:
    def __init__(self) -> None:
        self.tasks: list[asyncio.Task] = []
        self.wakeup = asyncio.Event()
        self.running: dict[str, asyncio.Task] = {}

    async def start(self) -> None:
        self.tasks = [
            asyncio.create_task(self._loop(), name=f"cae-preparation-{index}")
            for index in range(settings.cae_preparation_concurrency)
        ]

    async def stop(self) -> None:
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.tasks.clear()

    def cancel(self, job_id: str) -> None:
        task = self.running.get(job_id)
        if task:
            task.cancel()

    async def _claim(self) -> tuple[str, int, dict] | None:
        async with SessionLocal() as db:
            await serialize_events(db)
            waiting = exists(
                select(Job.id).where(
                    Job.batch_id == JobBatch.id,
                    or_(
                        Job.state == "preparing",
                        and_(Job.state == "queued", Job.input.is_not(None)),
                    ),
                )
            )
            needs_input = exists(
                select(Job.id).where(
                    Job.batch_id == JobBatch.id, Job.state == "queued", Job.input.is_(None)
                )
            )
            batch = await db.scalar(
                select(JobBatch)
                .join(CaeBatch, CaeBatch.batch_id == JobBatch.id)
                .where(
                    JobBatch.state.in_(("queued", "running")),
                    ~waiting,
                    or_(
                        needs_input,
                        and_(
                            JobBatch.generation_stopped.is_(False),
                            JobBatch.created_count < JobBatch.total,
                        ),
                    ),
                )
                .order_by(
                    JobBatch.last_prepared_at.asc().nulls_first(), JobBatch.created_at, JobBatch.id
                )
                .with_for_update(of=JobBatch, skip_locked=True)
                .limit(1)
            )
            if batch is None:
                await db.rollback()
                return None
            cae = await db.get(CaeBatch, batch.id)
            job = await db.scalar(
                select(Job)
                .where(Job.batch_id == batch.id, Job.state == "queued", Job.input.is_(None))
                .order_by(Job.item_index)
                .with_for_update()
                .limit(1)
            )
            if job is None:
                batch.created_count += 1
                job = Job(
                    user_id=batch.user_id,
                    batch_id=batch.id,
                    item_index=batch.created_count,
                    handler_type="cae.simulation",
                    slave_app_id="cae",
                    job_mode="websocket",
                    state="preparing",
                    attempt_count=1,
                    progress=[],
                    offer={},
                )
                db.add(job)
                await db.flush()
            job.state = "preparing"
            job.updated_at = utcnow()
            batch.state = "running"
            batch.last_prepared_at = utcnow()
            await add_event(db, batch, "job.preparing", job=job)
            await db.commit()
            return job.id, job.attempt_count, dict(cae.spec)

    async def _prepare(self, job_id: str, attempt: int, spec: dict) -> None:
        from gpstation.service.job_orchestrator import job_orchestrator

        result = None
        error = None
        try:
            result = await prepare_input(spec)
        except asyncio.CancelledError:
            raise
        except Exception as cause:
            logger.exception("CAE preparation failed: job=%s attempt=%s", job_id, attempt)
            error = str(cause) or type(cause).__name__
        async with SessionLocal() as db:
            await serialize_events(db)
            job = await db.scalar(
                select(Job)
                .where(Job.id == job_id, Job.attempt_count == attempt, Job.state == "preparing")
                .with_for_update()
            )
            if job is None:
                return
            if error is not None:
                await finish_job(db, job, "failed", error)
            else:
                cae = await db.get(CaeBatch, job.batch_id)
                measurement = await db.scalar(
                    select(Measurement).where(Measurement.job_id == job.id).with_for_update()
                )
                if measurement is None:
                    measurement = Measurement(
                        user_id=job.user_id,
                        experiment_id=cae.experiment_id,
                        vars=result["vars"],
                        material_parameters=result["material_parameters"],
                        job_id=job.id,
                    )
                    db.add(measurement)
                    await db.flush()
                job.input = {"measurement": result["measurement"]}
                job.state = "queued"
                job.updated_at = utcnow()
                batch = await db.get(JobBatch, job.batch_id)
                await add_event(
                    db,
                    batch,
                    "job.queued",
                    job=job,
                    payload={
                        "measurement_id": measurement.id,
                        "warnings": result.get("warnings", []),
                    },
                )
            await db.commit()
        job_orchestrator.wake_dispatcher()

    async def _loop(self) -> None:
        while True:
            try:
                claimed = await self._claim()
                if claimed:
                    job_id, attempt, spec = claimed
                    task = asyncio.create_task(self._prepare(job_id, attempt, spec))
                    self.running[job_id] = task
                    try:
                        await task
                    except asyncio.CancelledError:
                        if asyncio.current_task().cancelling():
                            raise
                    finally:
                        self.running.pop(job_id, None)
                    continue
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("CAE preparation queue failed")
            with suppress(TimeoutError):
                await asyncio.wait_for(self.wakeup.wait(), timeout=1)
            self.wakeup.clear()


preparation_queue = PreparationQueue()
