import pytest

from app.errors import CaeError
from app.program import validate_and_load_simulate


def test_accepts_exact_async_simulate_abi():
    simulate = validate_and_load_simulate(
        """
async def simulate(*, sim, tasks, vars):
    result = await sim.run(tasks["electric"])
    await sim.record("totalCurrent", result["artifacts"]["totalCurrent"])
    sim.release(result["artifacts"]["totalCurrent"])
    return result["state"]
""".strip()
    )

    assert simulate.__name__ == "simulate"


@pytest.mark.parametrize(
    "source, expected",
    [
        ("import os\nasync def simulate(*, sim, tasks, vars):\n    return None", "exactly one"),
        (
            "async def simulate(*, sim, tasks, vars):\n    return eval('1')",
            "eval",
        ),
        (
            "async def simulate(*, sim, tasks, vars):\n    return sim.__class__",
            "private",
        ),
        (
            "async def simulate(sim, tasks, vars):\n    return None",
            "signature",
        ),
        (
            'async def simulate(*, sim, tasks, vars):\n    tasks["electric"] = {}',
            "local names",
        ),
        (
            "async def simulate(*, sim, tasks, vars):\n"
            "    abs = int\n"
            "    return abs(1)",
            "reserved name",
        ),
        (
            'async def simulate(*, sim, tasks, vars):\n'
            '    writer = tasks["electric"].items\n'
            "    return None",
            "only direct sim",
        ),
    ],
)
def test_rejects_import_eval_private_attributes_and_wrong_signature(source, expected):
    with pytest.raises(CaeError, match=expected):
        validate_and_load_simulate(source)
