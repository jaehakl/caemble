"""Explicit pulse precision; independent of the interactive example's cost budget."""

import asyncio
from pathlib import Path

import numpy as np
import pytest

from app.kernel.coordinator.run import CaeRun
from app.kernel.transport import RecordPacket
from tests.microheater_fixtures import precision_pulse_measurement, pulse_response_times
from tests.recording_fixtures import decode_tensor_tree


@pytest.mark.validation
@pytest.mark.asyncio
async def test_pulse_original_mesh_and_time_refinement_preserve_energy_and_response(catalog_builds):
    results = []
    for dt in (2e-9, 1e-9):
        run = CaeRun(measurement=precision_pulse_measurement(catalog_builds, dt),
                     max_run_seconds=21600, job_id=f"pulse-precision-{dt:g}")
        run.start()
        records, sample_times = {}, {}
        try:
            while True:
                packet = await asyncio.wait_for(run.queue.get(), 21610)
                if not isinstance(packet, RecordPacket):
                    assert packet["kind"] == "complete", packet
                    break
                attachments = {part.id: part.data for part in packet.attachments}
                if packet.kind == "record":
                    records[packet.name] = decode_tensor_tree(run.schemas[packet.name], packet.value, attachments)[""]
                    sample_times[packet.name] = np.asarray(packet.value["axes"][3]["ticks"])
                else:
                    for value in packet.value.values():
                        decode_tensor_tree(value["schema"], value["data"], attachments)
                run.pending = packet
                run.acknowledge(packet.sequence)
            await run.task
            source = records["sourcePower"].ravel()[1:]
            loss = records["outwardPower"].ravel()[1:]
            energy = records["storedEnergy"].ravel()
            np.testing.assert_allclose(source * dt, np.diff(energy) + loss * dt,
                                       atol=source.max() * dt * 1e-6, rtol=0)
            np.testing.assert_allclose(source, records["power"].ravel(), rtol=1e-6)
            temperature = records["meanTemperature"].ravel()
            switch = round(40e-9 / dt)
            assert temperature[switch] > temperature[0]
            assert temperature[-1] < temperature[switch]
            assert np.all(records["power"].ravel()[switch:] == 0)
            response = pulse_response_times(sample_times["meanTemperature"], temperature,
                                            sample_times["power"], records["power"].ravel(),
                                            records["steadyMeanTemperature"].item())
            # This original 80 ns window does not reach either steady-reference
            # t90 or cooling t10: zero seconds must carry validity zero.
            np.testing.assert_array_equal(response, np.zeros((2, 2)))
            results.append({
                "temperatureRise": temperature[switch] - temperature[0],
                "power": records["power"].max(),
                "displacement": records["maximumNormalDisplacement"].max(),
                "storedEnergy": energy[switch],
            })
        finally:
            cache = Path(run.simulation_api._geometry_cache.name) if run.simulation_api else None
            await run.close()
            await asyncio.gather(run.task, return_exceptions=True)
            assert not run._record_packets
            if cache is not None:
                assert not cache.exists()
    for key, fine in results[1].items():
        assert fine > 0
        assert abs(results[0][key] / fine - 1) <= .02, key
