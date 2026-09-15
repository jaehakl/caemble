"""Authored Material/Interaction variants reach the real DEM preparation path."""

import json
import re
import subprocess
from copy import deepcopy
from pathlib import Path

import numpy as np
import pytest
from caemble_catalog import open_catalog

from app.kernel.coordinator import SimulationApi
from app.kernel.coordinator.run import CaeRun


@pytest.fixture(scope="module")
def dem_contract_inputs(tmp_path_factory):
    repo = Path(__file__).resolve().parents[4]
    directory = tmp_path_factory.mktemp("dem-contracts")
    with open_catalog() as catalog:
        files = catalog.experiment("dem-floor-contact")["sourceBundle"]["files"]
        descriptor = catalog.get_solver_manifest("dem", "1.0.0")["descriptor"]
    task_source = files["tasks/particles.tsx"]
    start = re.search(r"\bconfig\s*:\s*\(\s*\)\s*=>\s*\(\s*", task_source).end()
    config, consumed = json.JSONDecoder().raw_decode(task_source[start:])
    end = start + consumed
    clock = next(item["parameters"] for item in config["initializations"] if item["methodId"] == "dem.time")
    for name in ("duration", "windowSize", "outputInterval"):
        clock[name]["value"] = .15
    clock["duration"]["value"] = .3
    body = next(item for item in config["initializations"] if item["parameters"].get("kind") == "particles")
    body["parameters"]["velocity"] = {"value": [.5, 0, 0], "unit": "m.s-1", "dtype": "float64", "quantityKind": "kinematics.Velocity"}
    files["tasks/particles.tsx"] = task_source[:start] + json.dumps(config) + task_source[end:]
    defaults = {group["key"]: group["defaultModel"] for role in descriptor["interactions"] for group in role["modelGroups"]}
    cache = {}

    def build(name, sources, *, valid=True):
        if name in cache:
            return cache[name]
        source, artifact = directory / name / "source", directory / name / "build"
        for path, content in sources.items():
            target = source / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        result = subprocess.run([
            "node", str(repo / "app/ui/dist-cli/caemble.cjs"), "--repo", str(repo),
            "experiment", "build", str(source), "--vars-mode", "nominal", "--out", str(artifact),
        ], cwd=repo, capture_output=True, text=True, encoding="utf-8")
        if not valid:
            assert result.returncode != 0, result.stdout
            return result.stdout + result.stderr
        assert result.returncode == 0, result.stdout + result.stderr
        manifest = json.loads((artifact / "manifest.json").read_text(encoding="utf-8"))
        value = json.loads((artifact / manifest["items"][0]["file"]).read_text(encoding="utf-8"))["measurement"]
        cache[name] = value
        return value

    return files, defaults, build


def interaction_source(files, models):
    sources = dict(files)
    sources["material.tsx"] = sources["material.tsx"].replace("{ Material }", "{ Material, MaterialInteraction }")
    sources["material.tsx"] += (
        "\nexport const SampleWall = new MaterialInteraction('SampleWall', {"
        "between: [Sample(), Wall()], models: " + json.dumps(models) + "})\n"
    )
    return sources


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


@pytest.mark.parametrize("change", ["negative-stiffness", "wrong-unit", "missing-damper", "negative-friction"])
def test_invalid_authored_dem_coefficients_fail_without_default_fallback(dem_contract_inputs, change):
    files, defaults, build = dem_contract_inputs
    contact, friction = deepcopy(defaults["contact"]), deepcopy(defaults["friction"])
    if change == "negative-stiffness":
        contact["parameters"]["kn"]["value"] = -1
    elif change == "wrong-unit":
        contact["parameters"]["kn"]["unit"] = "s"
    elif change == "missing-damper":
        del contact["parameters"]["ct"]
    else:
        friction["parameters"]["muDynamic"]["value"] = -1
    output = build(change, interaction_source(files, {"contact": contact, "friction": friction}), valid=False)
    assert any(name in output for name in ("kn", "ct", "muDynamic")), output
