from __future__ import annotations

import asyncio
import json

from sdk.slave.object_storage import INLINE_BYTES, resolve_input, upload_object, externalize_record

from app.runtime import doctor, run_node


async def evaluate(message: dict, attachments: list, context) -> dict:
    if attachments:
        raise ValueError("Evaluation inputs use assigned object references, not attachments.")
    stage = message["stage"]
    if stage not in {"build", "calculate"}:
        raise ValueError("Unknown evaluation stage.")
    runtime = await asyncio.to_thread(doctor)
    if message.get("runtime_id") and message["runtime_id"] != runtime["runtime_id"]:
        raise ValueError("Evaluation runtime differs from the frozen Optimization runtime.")
    # The child receives only authored source/data; neither credentials nor job assignment.
    keys = ("build",) if stage == "build" else ("measurement_id", "recorded_data", "calculations")
    request = await resolve_input(context, {"stage": stage, **{key: message[key] for key in keys}})
    result = await run_node(request, runtime, timeout=120 if stage == "build" else 30 * max(1, len(request["calculations"])))
    raw = json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if stage == "build":
        value = {"input": result}
        if len(raw) > INLINE_BYTES:
            value["input"] = await upload_object(context, raw, "json")
            measurement = result["measurement"]
            experiment = measurement["experiment"]
            projection = {**measurement, "experiment": {**measurement["experiment"], "scene": {},
                          "taskScenes": {name: {} for name in experiment["taskScenes"]},
                          "simulationProgram": {**experiment["simulationProgram"], "pythonSource": ""}}}
            projection = await externalize_record(context, projection, {})
            projection["experiment"]["simulationProgram"]["pythonSource"] = experiment["simulationProgram"]["pythonSource"]
            projection["experiment"]["varsSchema"] = experiment["varsSchema"]
            value["projection"] = {"measurement": projection}
    else:
        value = result
    await context.send({"type": "job.record", "sequence": 1, "name": stage, "value": value})
    acknowledgement, attached = await asyncio.wait_for(context.receive(), timeout=120)
    if acknowledgement.get("type") != "job.record.ack" or acknowledgement.get("sequence") != 1 or attached:
        raise ValueError("Expected evaluation record acknowledgement.")
    return {"recordSequences": [1], "definition_hash": message["definition_hash"], "runtime_id": runtime["runtime_id"]}
