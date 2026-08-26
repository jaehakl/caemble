from __future__ import annotations

import pytest

from app.errors import CaeError
from app.runtime_kernel.coordinator.program import validate_and_load_simulate


def test_program_allows_nested_state_reads_and_explicit_artifact_handoff() -> None:
    source = """
async def simulate(*, sim, tasks, vars):
    electric = await sim.run(tasks["electric"])
    thermal = await sim.run(
        tasks["thermal"],
        state=electric["state"],
        inputs={"heatSource": electric["artifacts"]["jouleHeating"]},
    )
    await sim.record("temperature", thermal["state"]["fields"][0]["temperature"])
    return thermal["state"]
"""

    simulate = validate_and_load_simulate(
        source,
        task_names={"electric", "thermal"},
        recorded_names={"temperature"},
    )

    assert simulate.__name__ == "simulate"


def test_program_rejects_direct_state_item_mutation() -> None:
    source = """
async def simulate(*, sim, tasks, vars):
    result = await sim.run(tasks["electric"])
    result["state"]["step"] = 2
    return result["state"]
"""

    with pytest.raises(CaeError, match="assignment targets must be local names"):
        validate_and_load_simulate(
            source,
            task_names={"electric"},
            recorded_names=set(),
        )
