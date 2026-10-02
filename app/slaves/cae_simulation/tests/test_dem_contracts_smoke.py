"""Real DEM children preserve authored material and interaction selections."""

from copy import deepcopy
import re

import numpy as np
import pytest

from app.kernel.coordinator import SimulationApi
from app.kernel.coordinator.run import CaeRun
from tests.dem_contract_fixtures import dem_contract_inputs, interaction_source


@pytest.mark.asyncio
@pytest.mark.parametrize("variant", ["default", "friction", "spring", "same-material", "task-geometry"])
async def test_authored_dem_material_pairs_reach_prepared_models(dem_contract_inputs, variant):
    files, defaults, build = dem_contract_inputs
    sources = dict(files)
    expected_contact = deepcopy(defaults["contact"])
    expected_friction = deepcopy(defaults["friction"])
    if variant == "friction":
        expected_friction = {"model": "contact.coulomb@1", "parameters": {
            "muStatic": {"value": .9, "unit": "1"}, "muDynamic": {"value": .8, "unit": "1"}}}
        sources = interaction_source(files, {"friction": expected_friction})
    elif variant == "spring":
        expected_contact = {"model": "contact.linear-spring-damper@1", "parameters": {
            "kn": {"value": 14000., "unit": "N.m-1"}, "kt": {"value": 4200., "unit": "N.m-1"},
            "cn": {"value": 25., "unit": "N.s.m-1"}, "ct": {"value": 7., "unit": "N.s.m-1"}}}
        sources = interaction_source(files, {"contact": expected_contact})
    elif variant == "same-material":
        sources["experiment.tsx"] = sources["experiment.tsx"].replace("body: Wall()", "body: Sample()")
    elif variant == "task-geometry":
        experiment = sources["experiment.tsx"]
        start = re.search(r"\bgeometry\s*:\s*\(\s*\)\s*=>\s*\(?\s*<>", experiment).end()
        end = experiment.index("</>", start)
        bodies = experiment[start:end]
        sources["experiment.tsx"] = re.sub(r"\bgeometryGroup\s*:\s*\{[^}]*\}", "geometryGroup: {}", experiment[:start] + experiment[end:])
        sources["tasks/particles.tsx"] = (
            "import { Solid } from '../geometry'\nimport { Sample, Wall } from '../material'\n" + sources["tasks/particles.tsx"]
        ).replace("experiment.geometry.", "task.geometry.")
        sources["tasks/particles.tsx"] = re.sub(r"(\bgeometry\s*:\s*\(\s*\)\s*=>\s*\(?\s*<>)", lambda match: match[1] + bodies, sources["tasks/particles.tsx"])
        sources["tasks/particles.tsx"] = re.sub(r"\bgeometryGroup\s*:\s*\{", "geometryGroup:{sample:['sample'],floor:['floor'],", sources["tasks/particles.tsx"])
    measurement = build(variant, sources)
    run = CaeRun(measurement=measurement, max_run_seconds=60, job_id=f"dem-contract-{variant}")
    sim = SimulationApi(run)
    run.simulation_api = sim
    try:
        result = await sim.run(run.tasks["particles"])
        saved = result["state"].to_mutable(copy_arrays=True)["dem"]["particles"]
        model, particles = saved["model"], saved["state"]
        assert model["preparedModels"]
        moving = set(model["materialIndices"])
        wall = model["walls"][0]["materialIndex"]
        expected_pairs = {f"{min(first, second)}:{max(first, second)}" for first in moving for second in moving | {wall}}
        assert set(model["coefficients"]) == set(model["preparedModels"]) == expected_pairs
        pair = f"{min(next(iter(moving)), wall)}:{max(next(iter(moving)), wall)}"
        actual = model["preparedModels"][pair]
        assert actual["contact"]["model"] == expected_contact["model"]
        assert actual["friction"]["model"] == expected_friction["model"]
        expected = [expected_contact["parameters"][name]["value"] for name in ("kn", "kt", "cn", "ct")]
        expected += [expected_friction["parameters"][name]["value"] for name in ("muStatic", "muDynamic")]
        np.testing.assert_allclose(model["coefficients"][pair], expected, rtol=0, atol=0)
        for group, declaration in (("contact", expected_contact), ("friction", expected_friction)):
            for name, parameter in declaration["parameters"].items():
                assert actual[group]["parameters"][name]["unit"] == parameter["unit"]
        assert saved["state"].attributes["velocity"].values.shape == (len(model["mass"]), 3)
        if variant == "friction":
            assert saved["frictionDissipation"] > 0
            assert np.average(particles.attributes["velocity"].values[:, 0], weights=model["mass"]) < .5
        if variant == "same-material":
            assert len(model["materials"]) == 1 and moving == {wall}
        else:
            assert model["materials"][wall]["definition"]["models"] == {}
            assert f"{wall}:{wall}" not in model["coefficients"]
        if variant == "task-geometry":
            assert {entry["source"] for entry in particles.materials} == {"task"}
            assert {entry["task"] for entry in particles.materials} == {"particles"}
            assert all(root.startswith("task:") for root in model["provenance"]["rootIds"])
        sim.release((result["artifacts"], result["state"]))
    finally:
        await run.close()
