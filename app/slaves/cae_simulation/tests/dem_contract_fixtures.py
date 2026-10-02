"""Canonical-derived authored DEM input variants, shared without importing tests."""

import json
from pathlib import Path
import re
import subprocess

import pytest
from caemble_catalog import open_catalog


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
