import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import gpstation_master
import pytest

from app import prediction, worker
from app.runtime import EvaluationError


def test_batches_bound_input_count_and_wire_size():
    items = [{"candidateId": str(index), "input": {"direction": "forward", "vars": {"x": index}}} for index in range(70)]
    assert [len(batch) for batch in prediction.prediction_batches(items)] == [32, 32, 6]
    assert len(prediction.prediction_batches([{**item, "padding": "x" * 10000} for item in items[:5]])) == 3
    with pytest.raises(EvaluationError, match="transfer limit"):
        prediction.prediction_batches([{"candidateId": "huge", "input": "x" * 25000}])


class Client:
    def __init__(self, *, failure=None):
        self.failure = failure
        self.requests = []
        self.session = SimpleNamespace(call=self.call, finish=AsyncMock(), close=AsyncMock())
        self.kill_job = AsyncMock()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def run_job(self, action, payload, **kwargs):
        kwargs["on_job_created"](SimpleNamespace(id="child-job"))
        if self.failure == "connect":
            raise TimeoutError("No room for Predictor")
        return SimpleNamespace(session=self.session, payload={"protocolVersion": 2, "sessionId": "session",
            "storageId": "storage", "launcherId": "launcher"})

    async def call(self, action, payload, **kwargs):
        self.requests.append((action, payload))
        response = {"protocolVersion": 2, "sessionId": "session"}
        if action == "model.load":
            if self.failure == "missing":
                response["error"] = {"code": "missing-model", "message": "Pinned model is absent"}
            else:
                response["instance"] = {"handle": "instance"}
        elif action == "model.predict_batch":
            if self.failure == "cancel":
                raise asyncio.CancelledError()
            response["predictions"] = [{"candidateId": item["candidateId"], "output": [item["input"]["vars"]],
                "provenance": {"modelId": "model", "modelRevision": 9 if self.failure == "revision" else 2,
                    "manifestChecksum": "checksum", "datasetId": "dataset", "datasetRevision": 1}}
                for item in payload["inputs"]]
        return SimpleNamespace(payload=response)


def setup(monkeypatch, client, count=2):
    factory = lambda *args, **kwargs: client
    monkeypatch.setattr(gpstation_master, "GpStationClient", factory)
    node = AsyncMock(side_effect=[{"vars": {"x": index}, "rules": [{"label": "current"}],
        "candidate_box_grids": {"current": {"origin": [index, 0, 0]}}} for index in range(count)])
    monkeypatch.setattr(prediction, "run_node", node)
    upload = AsyncMock(return_value={"kind": "caemble.object", "id": "artifact"})
    monkeypatch.setattr(prediction, "upload_object", upload)
    message = {"hybrid": {"model_id": "model", "revision": 2, "checksum": "checksum", "storage_id": "storage", "launcher_id": "launcher"},
        "record_names": ["current"], "candidates": [{"candidate_id": str(index), "evaluation_id": f"evaluation-{index}", "build": {"vars": {"x": index}}} for index in range(count)]}
    context = SimpleNamespace(job_id="parent", assignment={"token": "only-parent-token", "attempt_id": "attempt",
        "websocket_url": "wss://example.invalid/api/v1/jobs/parent/stream"})
    return message, context, node, upload


async def test_prediction_keeps_model_session_and_persists_retry_inputs(monkeypatch):
    client = Client()
    message, context, node, upload = setup(monkeypatch, client, count=33)
    result = await prediction.predict(message, context, {"runtime_id": "runtime"})
    assert len(result["candidates"]) == 33
    assert result["provenance"] == {"model_id": "model", "revision": 2, "checksum": "checksum"}
    assert [action for action, _ in client.requests] == ["model.load", "model.predict_batch", "model.predict_batch", "model.release"]
    assert client.requests[0][1]["manifestChecksum"] == "checksum"
    assert upload.await_count == 33
    assert b'"candidate_box_grids"' in upload.await_args.args[1]
    assert all("token" not in str(call.args) for call in node.await_args_list)
    client.kill_job.assert_awaited_once_with("child-job")
    client.session.finish.assert_awaited_once()


@pytest.mark.parametrize("failure", ["missing", "revision", "cancel", "connect"])
async def test_prediction_failures_always_cleanup_and_never_publish_artifacts(monkeypatch, failure):
    client = Client(failure=failure)
    message, context, _, upload = setup(monkeypatch, client)
    expected = asyncio.CancelledError if failure == "cancel" else ValueError if failure == "revision" else EvaluationError
    with pytest.raises(expected) as raised:
        await prediction.predict(message, context, {"runtime_id": "runtime"})
    if failure == "connect":
        assert raised.value.code == "prediction-resource-wait"
    else:
        client.session.close.assert_awaited_once()
    upload.assert_not_awaited()
    client.kill_job.assert_awaited_once_with("child-job")


async def test_calculation_retry_uses_saved_prediction_without_inference(monkeypatch):
    node = AsyncMock(return_value={"calculations": [{"key": "objective", "value": 3}]})
    monkeypatch.setattr(worker, "run_node", node)
    monkeypatch.setattr(worker, "doctor", lambda: {"runtime_id": "runtime"})
    context = SimpleNamespace(send=AsyncMock(), receive=AsyncMock(return_value=({"type": "job.record.ack", "sequence": 1}, [])))
    await worker.evaluate({"stage": "calculate", "definition_hash": "hash", "candidate_id": "candidate", "evaluation_id": "evaluation",
        "prediction": {"output": [], "rules": [], "candidate_box_grids": {}}, "calculations": []}, [], context)
    assert node.await_args.args[0]["stage"] == "calculate_prediction"
    record = context.send.await_args.args[0]
    assert record["name"] == "calculate"
    assert record["value"]["candidate_id"] == "candidate"
    assert "measurement_id" not in record["value"]
