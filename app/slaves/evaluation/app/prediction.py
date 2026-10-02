"""Trusted Predictor orchestration; authored Node code only receives hydrated data."""
from __future__ import annotations

import asyncio
import contextlib
import json
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from sdk.slave.object_storage import upload_object
from prediction_contracts import PREDICTION_PROTOCOL_VERSION

from app.runtime import EvaluationError, run_node

MAX_BATCH_BYTES = 24 * 1024


def prediction_batches(inputs: list[dict]) -> list[list[dict]]:
    batches, batch = [], []
    for item in inputs:
        if len(json.dumps([item], separators=(",", ":"), allow_nan=False).encode("utf-8")) > MAX_BATCH_BYTES:
            raise EvaluationError({"code": "prediction-input-size", "message": "A candidate exceeds the Predictor input transfer limit."})
        proposed = [*batch, item]
        if len(proposed) > 32 or len(json.dumps(proposed, separators=(",", ":"), allow_nan=False).encode("utf-8")) > MAX_BATCH_BYTES:
            batches.append(batch)
            batch = []
        batch.append(item)
    if batch:
        batches.append(batch)
    return batches


def predictor_result(reply, *, session_id=None) -> dict:
    result = reply.payload
    if not isinstance(result, dict) or result.get("protocolVersion") != PREDICTION_PROTOCOL_VERSION:
        raise EvaluationError({"code": "prediction-protocol", "message": "Predictor returned an invalid response."})
    if result.get("error"):
        raise EvaluationError(result["error"])
    if session_id is not None and result.get("sessionId") != session_id:
        raise EvaluationError({"code": "prediction-session", "message": "Predictor session changed during evaluation."})
    return result


async def predict(message: dict, context, runtime: dict) -> dict:
    from gpstation_master import GpStationClient

    assignment = context.assignment
    if not assignment or not assignment.get("attempt_id"):
        raise ValueError("Prediction requires an assigned, attempt-scoped worker credential.")
    hybrid = message["hybrid"]
    candidates = message["candidates"]
    if not candidates or len({item["candidate_id"] for item in candidates}) != len(candidates):
        raise ValueError("Prediction candidates must have unique IDs.")
    prepared = []
    for item in candidates:
        value = await run_node({"stage": "predict_prepare", "build": item["build"],
                                "record_names": message["record_names"]}, runtime)
        prepared.append((item, value))
    batches = prediction_batches([{"candidateId": item["candidate_id"],
        "input": {"direction": "forward", "vars": value["vars"]}} for item, value in prepared])
    url = urlsplit(assignment["websocket_url"])
    base_path = url.path.rsplit("/v1/jobs/", 1)[0]
    base_url = urlunsplit(("https" if url.scheme == "wss" else "http", url.netloc, base_path, "", ""))
    prefix = f"/optimization/evaluation/{context.job_id}/attempts/{assignment['attempt_id']}/predictor-jobs"
    jobs, predictions = [], {}
    async with GpStationClient(base_url, assignment["token"], job_api_prefix=prefix, retry_before_input=False) as client:
        session = instance = None
        try:
            # Connection admission is bounded independently from inference time.
            try:
                async with asyncio.timeout(30):
                    first = await client.run_job("predictor.hello", {"protocolVersion": PREDICTION_PROTOCOL_VERSION, "requestId": str(uuid4())},
                        slave_app_id="predictor", auto_finish=False, timeout_seconds=30,
                        resources=hybrid["resources"]["predictor"], on_job_created=lambda job: jobs.append(job.id))
            except Exception as error:
                cause = error
                while cause is not None and not isinstance(cause, TimeoutError):
                    cause = cause.__cause__
                if cause is not None:
                    raise EvaluationError({"code": "prediction-resource-wait", "message": "Predictor connection exceeded 30 seconds; return evaluation to the queue."}) from error
                raise
            session = first.session
            hello = predictor_result(first)
            session_id = hello["sessionId"]
            if hello.get("storageId") != hybrid["storage_id"] or hello.get("launcherId") != hybrid["launcher_id"]:
                raise EvaluationError({"code": "prediction-storage", "message": "Predictor connected to a different model storage."})
            async def call(action, **payload):
                reply = await session.call(action, {"protocolVersion": PREDICTION_PROTOCOL_VERSION, "requestId": str(uuid4()),
                    "sessionId": session_id, **payload}, timeout_seconds=120)
                return predictor_result(reply, session_id=session_id)

            loaded = await call("model.load", modelId=hybrid["model_id"], revision=hybrid["revision"], manifestChecksum=hybrid["checksum"])
            instance = loaded["instance"]
            for batch in batches:
                response = await call("model.predict_batch", instance=instance, inputs=batch)
                values = response.get("predictions", [])
                if [value.get("candidateId") for value in values] != [item["candidateId"] for item in batch]:
                    raise ValueError("Predictor returned different candidate IDs.")
                for value in values:
                    provenance = value["provenance"]
                    if (provenance.get("modelId") != hybrid["model_id"] or provenance.get("modelRevision") != hybrid["revision"]
                            or provenance.get("manifestChecksum") != hybrid["checksum"]):
                        raise ValueError("Predictor returned a different model revision or checksum.")
                    predictions[value["candidateId"]] = value
            await call("model.release", instance=instance)
            instance = None
            await session.finish(timeout_seconds=15)
        finally:
            if session is not None:
                await session.close()
            # The API keeps the lease until the child process is confirmed reaped.
            for job_id in jobs:
                with contextlib.suppress(Exception):
                    await client.kill_job(job_id)
    results = []
    for item, value in prepared:
        prediction = predictions[item["candidate_id"]]
        artifact = {"output": prediction["output"], "rules": value["rules"],
                    "candidate_box_grids": value["candidate_box_grids"], "provenance": prediction["provenance"]}
        reference = await upload_object(context, json.dumps(artifact, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"), "json")
        results.append({"candidate_id": item["candidate_id"], "evaluation_id": item["evaluation_id"], "artifact": reference,
                        "provenance": prediction["provenance"]})
    return {"candidates": results, "provenance": {"model_id": hybrid["model_id"],
            "revision": hybrid["revision"], "checksum": hybrid["checksum"]}}
