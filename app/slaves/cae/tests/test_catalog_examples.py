"""Compile every official bundle and execute its nominal Measurement in real children."""
from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path

import numpy as np
import pytest

from app.kernel.coordinator.run import CaeRun
from app.kernel.transport import RecordPacket
from app.kernel.transport.tensor import dtype_for


@pytest.fixture(scope="module")
def catalog_measurements(tmp_path_factory):
    ui = Path(__file__).resolve().parents[3] / "ui"
    output = tmp_path_factory.mktemp("catalog-measurements")
    subprocess.run([
        "node", "node_modules/esbuild/bin/esbuild", "scripts/test-catalog-examples.ts",
        "--bundle", "--platform=node", "--format=esm", "--external:typescript",
        "--external:@babel/*", "--alias:@=./src",
        "--outfile=node_modules/.tmp/test-catalog-examples.mjs",
    ], cwd=ui, check=True, capture_output=True, text=True, encoding="utf-8")
    subprocess.run([
        "node", "node_modules/.tmp/test-catalog-examples.mjs",
        str(ui.parent / "catalog/caemble_catalog/catalog.sqlite3"), str(output),
    ], cwd=ui, check=True, capture_output=True, text=True, encoding="utf-8")
    return output


@pytest.mark.parametrize("key", [
    "fiber-bundle", "shell-cutaways", "random-curved-edge-cylinder-array",
    "random-curved-surface-sphere-hcp-array", "two-material-wheel-assembly",
    "czerny-turner-spectrometer", "electro-thermal-notched-bar",
    "fdtd-drude-slab", "folded-ray-tracing",
])
@pytest.mark.asyncio
async def test_official_catalog_measurement_runs_and_acknowledges_every_record(key, catalog_measurements):
    measurement = json.loads((catalog_measurements / f"{key}.json").read_text(encoding="utf-8"))
    run = CaeRun(measurement=measurement, max_run_seconds=240, job_id=f"catalog-{key}", on_cleanup=lambda _: None)
    run.first_next_watchdog.cancel()
    run.task = asyncio.create_task(run._execute())
    recorded = {}
    try:
        while True:
            packet = await asyncio.wait_for(run.queue.get(), timeout=250)
            if isinstance(packet, RecordPacket):
                assert not packet.ack.done()
                assert packet.resource_hold is not None
                leaves = [(packet.name, run.schemas[packet.name], packet.value)]
                attachments = {item.id: item.data for item in packet.attachments}
                while leaves:
                    name, schema, value = leaves.pop()
                    if "dtype" not in schema:
                        leaves.extend((f"{name}.{member}", member_schema, value[member]) for member, member_schema in schema.items())
                        continue
                    storage = value["storage"]
                    if storage["kind"] == "inline":
                        array = np.asarray(storage["value"])
                    else:
                        raw = b"".join(attachments[identifier] for identifier in storage["ids"])
                        array = np.frombuffer(raw, dtype=dtype_for(schema["dtype"])).reshape(value["shape"])
                    assert list(array.shape) == value["shape"]
                    assert array.size > 0
                    assert np.all(np.isfinite(array)), name
                    recorded[name] = array.copy()
                run.pending = packet
                run._acknowledge(packet.sequence)
                assert packet.ack.done()
                assert packet.attachments == []
                continue
            if packet["kind"] in {"complete", "failed"}:
                assert packet["kind"] == "complete", packet
                break
        await run.task
        assert set(run.recorded_names) == set(run.schemas)
        assert run.completed_sequences == list(range(1, len(run.schemas) + 1))
        assert len(run.trace) == len(measurement["experiment"]["simulationProgram"]["tasks"])
        if "totalCurrent" in recorded:
            assert recorded["totalCurrent"] > 0
        if "maximumTemperature" in recorded:
            assert recorded["maximumTemperature"] > measurement["experiment"]["variables"]["fixedTemperature"]
        if "detectorPower" in recorded:
            assert recorded["detectorPower"] > 0
            assert 0 < recorded["detectorEfficiency"] <= 1
        if "rayPaths.pathOffsets" in recorded:
            offsets = recorded["rayPaths.pathOffsets"]
            assert offsets[-1] == len(recorded["rayPaths.vertices"])
            assert len(offsets) == len(recorded["rayPaths.pathWavelength"]) + 1
        if "timeElectricField.field" in recorded:
            assert np.max(np.abs(recorded["timeElectricField.field"])) > 0
        assert run._record_packets == {}
    finally:
        run.abort()
        await asyncio.gather(run.task, return_exceptions=True)
