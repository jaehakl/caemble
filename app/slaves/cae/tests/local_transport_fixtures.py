"""Small local transport harness with the real recording and ACK lifecycle."""

from app.kernel.coordinator.plan import RunPlan
from app.kernel.coordinator.simulation import SimulationApi


ORIGINAL_RECORD = SimulationApi.record


def transport_plan(measurement, tasks, schemas):
    # Transport tests isolate serialization and ACKs from Catalog compilation.
    contracts = {name: {"task": "fixture", "output": name, "solver": {"name": "fixture", "version": "1"},
                        "artifactType": "fixture/" + name} for name in schemas}
    return RunPlan({}, {}, {}, schemas, contracts)


async def record_fixture_artifact(self, name, value):
    handle = self._artifacts.publish(value, producer_task="fixture", output_name=name,
        solver_name="fixture", solver_version="1", artifact_type="fixture/" + name, state_revision=0)
    try:
        return await ORIGINAL_RECORD(self, name, handle)
    finally:
        self.release(handle)
