"""Launcher-managed training jobs; browser sessions never own their lifetime."""
from __future__ import annotations

import asyncio
import json
import threading
from urllib.parse import urlparse
from urllib.request import Request

from prediction_contracts import validate_allocation
from sdk.slave.server import ServerSlaveApp, run_server_app

from .errors import PredictionError
from .runtime import PredictorRuntime
from .storage import check_cancel


async def run_training(message: dict, attachments, context) -> dict:
    if attachments:
        raise PredictionError("invalid-request", "Training accepts revision references, not inline attachments.")
    runtime = PredictorRuntime.from_context(context)
    spec = message
    allocation = context.execution.allocation.model_dump()
    try:
        validate_allocation(spec["definition"], "training", allocation)
    except ValueError as error:
        raise PredictionError("resource-allocation", str(error)) from error
    cancelled = threading.Event()
    loop = asyncio.get_running_loop()

    def dataset_reference():
        url = spec["datasetAccessUrl"]
        trusted, actual = urlparse(runtime.training.api_url), urlparse(url)
        assignment = context.assignment
        expected = trusted.path.rstrip("/") + f"/prediction/training/jobs/{context.job_id}/attempts/{assignment['attempt_id']}/dataset"
        if ((actual.scheme, actual.netloc, actual.path) != (trusted.scheme, trusted.netloc, expected)
                or actual.username or actual.password or actual.query or actual.fragment):
            raise PredictionError("data-access", "Training Dataset access belongs to another execution attempt.")
        with runtime.training.opener.open(Request(url, headers={"Authorization": f"Bearer {assignment['token']}"}), timeout=60) as response:
            raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise PredictionError("memory-limit", "Training Dataset reference exceeds its metadata budget.")
        return json.loads(raw)

    def progress(value):
        check_cancel(cancelled)
        payload = {"stage": value} if isinstance(value, str) else value
        future = asyncio.run_coroutine_threadsafe(context.send({"type": "job.progress", "progress": payload}), loop)
        try:
            future.result(timeout=15)
        except BaseException:
            future.cancel()
            raise

    task = asyncio.create_task(asyncio.to_thread(runtime.training.train, spec, dataset_reference, cancelled, progress))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        cancelled.set()
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if not task.cancelled():
            task.exception()
        raise


app = ServerSlaveApp(run_training)

if __name__ == "__main__":
    run_server_app(app)
