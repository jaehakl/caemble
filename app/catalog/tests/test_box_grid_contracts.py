from copy import deepcopy
import json
from pathlib import Path
import re
import shutil
import subprocess

import pytest

from caemble_catalog import open_catalog
from caemble_catalog.admin import validate_artifact_data, validate_output_contracts
from caemble_catalog.errors import CatalogError


def test_published_outputs_are_seven_axis_tensors_with_separate_native_exports_and_visualizations():
    with open_catalog() as catalog:
        manifests = catalog.solver_manifests()
        for manifest in manifests:
            descriptor = manifest["descriptor"]
            validate_output_contracts(catalog, descriptor)
            assert descriptor["minimumOutputs"] == 0
            assert all(method["artifactType"].startswith("caemble.box-grid/") for method in descriptor["methods"]["outputs"])
            assert all("boxGrid" not in method["data"] for method in descriptor["methods"]["exports"])
        structural = catalog.get_solver_manifest("structural-mechanics", "8.0.0")["descriptor"]
        assert set(structural["visualizations"]) == {"displacement", "stress", "displacementHistory", "harmonicDisplacement", "harmonicStress", "volumeRatio", "meanPressure"}
        assert {item["methodId"] for item in structural["methods"]["exports"]} == {"fea.interface", "fea.motion", "fea.harmonic-surface-motion", "fea.transient-surface-motion", "fea.deformation-gradient", "fea.first-piola-stress"}
        acoustic = catalog.get_solver_manifest("pressure-acoustics", "1.1.0")["descriptor"]
        surface = next(item for item in structural["methods"]["exports"] if item["methodId"] == "fea.harmonic-surface-motion")
        assert acoustic["inputPorts"]["surfaceMotion"]["artifactTypes"] == [surface["artifactType"]]
        assert acoustic["inputPorts"]["surfaceMotion"]["data"] == surface["data"]
        assert set(surface["data"]["members"]) == {"frequencies", "velocity"}
        assert surface["target"]["kind"] == "surface"
        assert surface["data"]["members"]["velocity"]["quantityKind"] == "kinematics.Velocity"
        ray = catalog.get_solver_manifest("ray-tracing", "4.0.0")["descriptor"]
        assert set(ray["visualizations"]) == {"paths"}
        assert {item["methodId"] for item in ray["methods"]["outputs"]} == {"ray.fluence-rate", "ray.radiant-flux-density"}
        assert "ray.absorbing-detector" in {item["methodId"] for item in ray["methods"]["boundaryConditions"]}


def test_publishing_rejects_invalid_shape_channels_components_and_target_contracts():
    with open_catalog() as catalog:
        original = catalog.get_solver_manifest("fdtd", "5.0.0")["descriptor"]
        for field, value in [
            ("axes", [{"name": "x"}]),
            ("dtype", "complex64"),
            ("boxGrid", {**original["methods"]["outputs"][0]["data"]["boxGrid"], "components": ["z", "x", "y"]}),
            ("boxGrid", {**original["methods"]["outputs"][0]["data"]["boxGrid"], "channels": ["real", "imag"]}),
        ]:
            descriptor = deepcopy(original)
            descriptor["methods"]["outputs"][0]["data"][field] = value
            with pytest.raises(CatalogError):
                validate_output_contracts(catalog, descriptor)
        descriptor = deepcopy(original)
        descriptor["methods"]["outputs"][0]["parameters"].pop("gridShape")
        with pytest.raises(CatalogError, match="gridShape"):
            validate_output_contracts(catalog, descriptor)
        descriptor = deepcopy(original)
        descriptor["methods"]["outputs"][0]["target"]["kind"] = "surface"
        with pytest.raises(CatalogError, match="Box geometry"):
            validate_output_contracts(catalog, descriptor)


def test_scoped_runtime_includes_automatic_mesh_coordinate_dependencies():
    with open_catalog() as catalog:
        runtime = catalog.runtime_slice(solvers=[("structural-mechanics", "8.0.0")], quantity_kinds=[], material_models=[])
    quantities = {item["name"] for item in runtime["quantityKinds"]}
    assert {"Length", "Volume", "Dimensionless", "mechanics.ForceMagnitude"} <= quantities


def test_mini_contract_keeps_pressure_energy_and_native_averaging_distinct():
    with open_catalog() as catalog:
        descriptor = catalog.get_solver_manifest('structural-mechanics', '8.0.0')['descriptor']
    formulation = descriptor['parameters']['solidFormulation']
    assert formulation['required'] is False
    assert formulation['data']['values'] == ['displacement', 'mixed-mini']
    boundaries = {item['methodId']: item for item in descriptor['methods']['boundaryConditions']}
    assert boundaries['fea.follower-pressure']['parameters'] == boundaries['fea.pressure']['parameters']
    outputs = {item['methodId']: item for item in descriptor['methods']['outputs']}
    for name, configuration in [('fea.mean-pressure', 'reference'), ('fea.current-mean-pressure', 'current')]:
        data = outputs[name]['data']
        assert (data['quantityKind'], data['unit']) == ('Pressure', 'Pa')
        assert data['axes'][6]['length'] == 1
        assert data['boxGrid']['configuration'] == configuration
    for name in ('fea.strain-energy', 'fea.equilibrium-energy'):
        assert outputs[name]['data']['unit'] == 'J'
        assert outputs[name]['data']['boxGrid']['sampling'] == 'aggregate'
    mean_pressure = descriptor['visualizations']['meanPressure']['data']['visualization']
    assert mean_pressure['components'] == ['meanPressure']
    assert mean_pressure['signConvention'] == 'compression-positive'
    for name in ('stress', 'volumeRatio', 'meanPressure'):
        semantic = descriptor['visualizations'][name]['data']['visualization']
        assert (semantic['sampling'], semantic['weighting']) == ('cell-average', 'reference-volume')


def test_only_explicit_symmetric_quantities_allow_six_tensor_components():
    with open_catalog() as catalog:
        assert catalog.quantity_kind("mechanics.StressTensor")["tensorSymmetry"] == "symmetric"
        assert catalog.quantity_kind("mechanics.Strain")["tensorSymmetry"] == "symmetric"
        descriptor = catalog.get_solver_manifest("structural-mechanics", "8.0.0")["descriptor"]
        stress = next(item for item in descriptor["methods"]["outputs"] if item["methodId"] == "fea.stress-field")
        descriptor["methods"]["outputs"] = [stress]
        for quantity, unit in (("mechanics.FirstPiolaStress", "Pa"), ("mechanics.DeformationGradient", "1")):
            assert catalog.quantity_kind(quantity)["tensorSymmetry"] == "general"
            data = stress["data"]
            data["quantityKind"], data["unit"] = quantity, unit
            data["boxGrid"]["channelUnits"] = [unit]
            data["boxGrid"]["components"] = ["xx", "yy", "zz", "xy", "yz", "xz"]
            with pytest.raises(CatalogError, match="tensor symmetry"):
                validate_output_contracts(catalog, descriptor)
            labels = [a + b for a in "xyz" for b in "xyz"]
            data["boxGrid"]["components"] = labels
            data["axes"][-1].update(length=9, ticks=labels)
            validate_output_contracts(catalog, descriptor)


def test_sph_pressure_contract_distinguishes_material_average_and_full_cell_density():
    with open_catalog() as catalog:
        descriptor = catalog.get_solver_manifest("sph", "1.1.0")["descriptor"]
        validate_output_contracts(catalog, descriptor)
    outputs = {item["methodId"]: item for item in descriptor["methods"]["outputs"]}
    pressure, density = outputs["sph.pressure"], outputs["sph.mass-density"]
    data = pressure["data"]
    assert pressure["artifactType"] == "caemble.box-grid/sph/pressure@1"
    assert (data["quantityKind"], data["unit"], data["dtype"]) == ("Pressure", "Pa", "float64")
    assert data["boxGrid"] == {"version": 1, "sampling": "cell-average", "components": ["value"],
                               "channels": ["value"], "channelUnits": ["Pa"],
                               "configuration": "current", "weighting": "material-volume"}
    assert pressure["parameters"] == density["parameters"]
    assert pressure["target"] == density["target"]
    assert "weighting" not in density["data"]["boxGrid"]
    assert "rho_i" in pressure["description"] and "mass-density > 0" in pressure["description"]


def test_incompressible_outputs_separate_physical_time_material_averages_and_full_cell_density():
    with open_catalog() as catalog:
        manifest = catalog.get_solver_manifest("incompressible-flow", "3.0.0")
        descriptor = manifest["descriptor"]
        validate_output_contracts(catalog, descriptor)
        example = catalog.experiment("incompressible-stokes-duct")
    assert manifest["abiVersion"] == 3
    assert manifest["implementation"] == "app.solvers.incompressible_flow.entry:implementation"
    assert descriptor["parameters"]["gravity"]["required"] is False
    assert descriptor["parameters"]["spatialResolution"]["data"]["unit"] == "m"
    analysis = descriptor["parameters"]["analysis"]
    assert analysis.get("required", True)
    assert analysis["data"]["values"] == ["steady-stokes", "transient-navier-stokes"]
    assert descriptor["materials"][0]["modelGroups"] == [
        {"key": "constitutive", "required": True, "oneOf": ["fluidDynamics.newtonian-fluid@1"]},
    ]
    outputs = {item["methodId"]: item for item in descriptor["methods"]["outputs"]}
    assert set(outputs) == {"flow.pressure", "flow.velocity", "flow.mass-density",
                            "flow.volume-flow-rate", "flow.mass-flow-rate", "flow.surface-pressure",
                            "flow.force", "flow.moment"}
    for output in (outputs[name] for name in ("flow.pressure", "flow.velocity", "flow.mass-density")):
        time_axis, frequency_axis = output["data"]["axes"][3:5]
        assert time_axis == {"name": "time", "quantityKind": "Time", "unit": "s"}
        assert frequency_axis["length"] == 1 and frequency_axis["ticks"] == [0]
        assert output["data"]["boxGrid"]["configuration"] == "current"
        assert set(output["parameters"]) == {"gridShape", "scope"}
        assert output["parameters"]["scope"]["required"] is False
        assert output["parameters"]["scope"]["data"]["values"] == ["cumulative", "final"]
        assert output["artifactType"] == "caemble.box-grid/incompressible-flow/" + output["methodId"][5:] + "@3"
    for name in ("flow.pressure", "flow.velocity"):
        assert outputs[name]["data"]["boxGrid"]["weighting"] == "material-volume"
    assert "weighting" not in outputs["flow.mass-density"]["data"]["boxGrid"]
    assert [method["methodId"] for method in descriptor["methods"]["exports"]] == ["flow.traction"]
    assert set(descriptor["visualizations"]) == {"pressure", "velocity", "traction"}
    for name, visual in descriptor["visualizations"].items():
        assert visual["data"]["axes"][:2] == [
            {"name": "cell"}, {"name": "time", "quantityKind": "Time", "unit": "s", "length": 1},
        ]
        assert visual["data"]["tensorOrder"] == 0
        assert visual["data"]["recording"] == "mesh-field"
        assert visual["artifactType"] == f"caemble.incompressible-flow/{name}-field@{1 if name == 'traction' else 3}"
    assert descriptor["visualizations"]["velocity"]["data"]["axes"][2] == {
        "name": "component", "length": 3, "ticks": ["x", "y", "z"],
    }
    boundaries = {item["methodId"]: item for item in descriptor["methods"]["boundaryConditions"]}
    assert set(boundaries) == {"flow.no-slip", "flow.velocity-inlet", "flow.pressure-open", "flow.periodic"}
    assert "minimum" not in boundaries["flow.pressure-open"]["parameters"]["pressure"]["data"]
    assert all(boundaries[name]["target"]["minimumResolved"] == 1 for name in ("flow.no-slip", "flow.velocity-inlet", "flow.pressure-open"))
    assert "pressureReference" in descriptor["observations"]
    assert example["relatedSolvers"][0]["name"] == "incompressible-flow"
    assert 'sim.release(flow["state"])' in example["sourceBundle"]["files"]["simulate.py"]


def test_incompressible_transient_time_and_startup_example_keep_continuation_explicit():
    with open_catalog() as catalog:
        descriptor = catalog.get_solver_manifest("incompressible-flow", "3.0.0")["descriptor"]
        startup = catalog.experiment("incompressible-startup-channel")
        steady = catalog.experiment("incompressible-stokes-duct")
    time = next(item for item in descriptor["methods"]["initializations"] if item["methodId"] == "flow.time")
    assert (time["minimumOccurrences"], time["maximumOccurrences"]) == (0, 1)
    assert all(time["target"][name] == 0 for name in
               ("minimumTargets", "maximumTargets", "minimumResolved", "maximumResolved"))
    assert set(time["parameters"]) == {"dt", "duration", "windowSize", "outputInterval"}
    for parameter in time["parameters"].values():
        assert parameter.get("required", True)
        assert parameter["data"]["dtype"] == "float64"
        assert parameter["data"]["quantityKind"] == "Time" and parameter["data"]["unit"] == "s"
        assert parameter["data"]["minimum"] == 0
        assert parameter["data"]["exclusiveMinimum"] is True
    assert {"analysis", "time", "stepCount", "retryCount", "lastDt", "maxCourant"} <= set(descriptor["observations"])
    for name in ("maxCourant", "maxNonlinearIterations"):
        assert descriptor["parameters"][name]["required"] is False
    sources = startup["sourceBundle"]["files"]
    assert "analysis: 'transient-navier-stokes'" in sources["tasks/flow.tsx"]
    assert "methodId: 'flow.time'" in sources["tasks/flow.tsx"]
    assert 'state=previous["state"]' in sources["simulate.py"]
    assert 'sim.release(previous["state"], keep=flow["state"])' in sources["simulate.py"]
    assert "analysis: 'steady-stokes'" in steady["sourceBundle"]["files"]["tasks/flow.tsx"]


def test_incompressible_boundary_outputs_keep_box_targets_and_persist_physical_semantics():
    with open_catalog() as catalog:
        descriptor = catalog.get_solver_manifest("incompressible-flow", "3.0.0")["descriptor"]
        traction_quantity = catalog.quantity_kind("mechanics.Traction")
        runtime = catalog.runtime_slice(solvers=[("incompressible-flow", "3.0.0")], quantity_kinds=[])
    assert traction_quantity["tensorOrder"] == 1
    assert "Pa" in traction_quantity["applicableUnits"]
    assert {"kinematics.Acceleration", "mechanics.Traction", "Length"} <= {
        item["name"] for item in runtime["quantityKinds"]
    }
    initializations = {item["methodId"]: item for item in descriptor["methods"]["initializations"]}
    observe = initializations["flow.observe-surface"]
    assert observe["target"]["kind"] == "surface"
    assert observe["parameters"]["name"].get("required", True)
    periodic = next(item for item in descriptor["methods"]["boundaryConditions"] if item["methodId"] == "flow.periodic")
    assert periodic["target"]["kind"] == "surface"
    assert (periodic["target"]["minimumTargets"], periodic["target"]["maximumTargets"]) == (2, 2)
    assert periodic["parameters"]["translation"]["data"]["axes"][0]["length"] == 3
    outputs = {item["methodId"]: item for item in descriptor["methods"]["outputs"]}
    base = {"pressureKind", "pressureReference", "pressureReferencePoint", "hydrostaticGravity", "drivingAcceleration", "coordinateFrame"}
    for name, method in outputs.items():
        assert method["target"]["kind"] == "geometry"
        assert base <= set(method["data"]["metadata"])
        if method["data"]["boxGrid"]["sampling"] == "aggregate":
            assert method["parameters"]["surface"].get("required", True)
            assert method["artifactType"].endswith("@1")
            assert {"surfaceTargets", "normalConvention"} <= set(method["data"]["metadata"])
    for name in ("flow.force", "flow.moment"):
        assert outputs[name]["parameters"]["pressureOffset"]["required"] is False
        assert outputs[name]["parameters"]["contribution"]["data"]["values"] == ["total", "pressure", "viscous"]
        assert {"pressureOffset", "contribution", "actionTarget"} <= set(outputs[name]["data"]["metadata"])
    assert outputs["flow.moment"]["parameters"]["momentOrigin"].get("required", True)
    assert "momentOrigin" not in outputs["flow.force"]["parameters"]
    traction = descriptor["visualizations"]["traction"]
    exported = descriptor["methods"]["exports"][0]
    assert exported["target"]["kind"] == "surface"
    assert traction["artifactType"] == exported["artifactType"]
    assert traction["data"] == exported["data"]
    assert traction["data"]["mesh"] == {"version": 1, "cellType": "tri3"}
    assert traction["data"]["quantityKind"] == "mechanics.Traction"


@pytest.mark.parametrize("field", [
    {"dtype": "complex128", "quantityKind": "Pressure", "unit": "Pa"},
    {"dtype": "float64", "unit": "Pa"},
    {"dtype": "float64", "quantityKind": "Pressure", "unit": "Pa", "shape": [-1]},
    {"dtype": "string", "values": ["wall", "wall"]},
])
def test_result_metadata_rejects_ambiguous_or_untyped_contracts(field):
    with pytest.raises(CatalogError, match="metadata"):
        validate_artifact_data({"metadata": {"load": field}}, "result")


def test_surface_mesh_contract_requires_explicit_supported_topology():
    for mesh in ({"version": 1, "cellType": "tri3"}, {"version": 1, "cellType": "tet4"}):
        validate_artifact_data({"recording": "mesh-field", "mesh": mesh}, "result")
    for data in ({"mesh": {"version": 1, "cellType": "tri3"}},
                 {"recording": "mesh-field", "mesh": {"version": 1, "cellType": "hex8"}}):
        with pytest.raises(CatalogError, match="mesh"):
            validate_artifact_data(data, "result")


@pytest.fixture(scope="module")
def incompressible_cli():
    """Build-only integration uses the installed checkout CLI; Catalog alone needs no Node."""
    repo = Path(__file__).resolve().parents[3]
    cli = repo / "app/ui/dist-cli/caemble.cjs"
    node = shutil.which("node")
    if node is None or not cli.is_file():
        pytest.skip("Public build regression requires Node and app/ui npm run build:cli")
    with open_catalog() as catalog:
        files = catalog.experiment("incompressible-startup-channel")["sourceBundle"]["files"]
    return repo, [node, str(cli), "--repo", str(repo)], files


@pytest.mark.parametrize("case", [
    "missing-analysis", "invalid-analysis", "removed-solver", "previous-solver", "time-target", "duplicate-time",
    "invalid-scope",
    *[f"{name}-{value}" for name in ("dt", "duration", "windowSize", "outputInterval")
      for value in ("missing", "zero", "negative")],
])
def test_incompressible_public_build_rejects_invalid_contracts(case, incompressible_cli, tmp_path):
    repo, cli, files = incompressible_cli
    source = files["tasks/flow.tsx"]
    if case == "missing-analysis":
        changed = re.sub(r"^\s*analysis: 'transient-navier-stokes',\n", "", source, count=1, flags=re.MULTILINE)
        expected = "analysis"
    elif case == "invalid-analysis":
        changed = source.replace("analysis: 'transient-navier-stokes'", "analysis: 'navier-stokes'")
        expected = "analysis"
    elif case in {"removed-solver", "previous-solver"}:
        changed = source.replace("version: '3.0.0'", "version: '1.0.0'" if case == "removed-solver" else "version: '2.0.0'")
        expected = "no semantic Catalog contract"
    elif case == "time-target":
        changed = source.replace("target: []", "target: ['experiment.geometry.fluid']", 1)
        expected = "target must contain 0..0 targets"
    elif case == "duplicate-time":
        start = source.index("      {\n        methodId: 'flow.time'")
        end = source.index("    ],\n    boundaryConditions:", start)
        changed = source[:end] + source[start:end] + source[end:]
        expected = "flow.time"
    elif case == "invalid-scope":
        changed = source.replace("parameters: { gridShape:", "parameters: { scope: 'invalid', gridShape:", 1)
        expected = "scope"
    else:
        name, value = case.split("-")
        line = re.search(rf"^.*\b{name}: \{{[^\n]*\n", source, flags=re.MULTILINE).group()
        replacement = "" if value == "missing" else re.sub(r"value: [\d.]+", "value: " + ("0" if value == "zero" else "-1"), line)
        changed = source.replace(line, replacement, 1)
        expected = name
    assert changed != source, case
    for name, content in files.items():
        path = tmp_path / "source" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(changed if name == "tasks/flow.tsx" else content, encoding="utf-8")
    result = subprocess.run([*cli, "experiment", "build", str(tmp_path / "source"),
                             "--out", str(tmp_path / "build"), "--vars-mode", "nominal"],
                            cwd=repo, capture_output=True, text=True, encoding="utf-8", timeout=60)
    diagnostic = result.stdout + result.stderr
    assert result.returncode != 0, diagnostic
    assert expected in diagnostic, diagnostic
    assert not (tmp_path / "build" / "manifest.json").exists()


@pytest.mark.parametrize("scope", [None, "cumulative", "final"])
def test_incompressible_public_build_freezes_scope_and_new_artifact_versions(scope, incompressible_cli, tmp_path):
    repo, cli, files = incompressible_cli
    for name, content in files.items():
        if name == "tasks/flow.tsx" and scope is not None:
            content = content.replace("parameters: { gridShape:", f"parameters: {{ scope: '{scope}', gridShape:")
        path = tmp_path / "source" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    result = subprocess.run([*cli, "experiment", "build", str(tmp_path / "source"),
                             "--out", str(tmp_path / "build"), "--vars-mode", "nominal"],
                            cwd=repo, capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
    manifest = json.loads((tmp_path / "build" / "manifest.json").read_text(encoding="utf-8"))
    item = json.loads((tmp_path / "build" / manifest["items"][0]["file"]).read_text(encoding="utf-8"))
    program = item["measurement"]["experiment"]["simulationProgram"]
    task = program["tasks"]["flow"]
    assert task["kernel"] == {"name": "incompressible-flow", "version": "3.0.0"}
    assert task["config"]["parameters"]["analysis"] == "transient-navier-stokes"
    for output in task["config"]["outputs"]:
        assert output["parameters"].get("scope") == scope
    for name in ("pressure", "velocity", "density"):
        assert program["resultContracts"][name]["artifactType"].endswith("@3")
    for name, native in program["visualizationContracts"]["flow"].items():
        assert native["artifactType"].endswith("@1" if name == "traction" else "@3")


def test_b3_examples_package_only_two_new_experiments_and_executable_calculations():
    with open_catalog() as catalog:
        examples, count = catalog.list_experiments(solver_name="incompressible-flow", limit=20)
        boolean = catalog.experiment("incompressible-boolean-channel")
        comparison = catalog.experiment("incompressible-sph-periodic-channel")
        assert catalog.experiment("incompressible-stokes-duct")["version"] == "3.0.0"
        assert catalog.experiment("incompressible-startup-channel")["version"] == "2.0.0"
    assert count == 4
    assert {item["key"] for item in examples} == {
        "incompressible-stokes-duct", "incompressible-startup-channel",
        "incompressible-boolean-channel", "incompressible-sph-periodic-channel",
    }
    assert boolean["version"] == "1.1.0"
    assert comparison["version"] == "1.1.0"
    assert "<subtract>" in boolean["sourceBundle"]["files"]["geometry.tsx"]
    assert "methodId: 'flow.traction'" in boolean["sourceBundle"]["files"]["tasks/flow.tsx"]
    assert len(boolean["calculations"]) == len(comparison["calculations"]) == 4
    assert {(item["name"], item["version"]) for item in comparison["relatedSolvers"]} == {
        ("incompressible-flow", "3.0.0"), ("sph", "1.1.0"),
    }
    program = comparison["sourceBundle"]["files"]["simulate.py"]
    assert 'sim.run(tasks["flow"], state=previous["state"])' in program
    assert 'sim.run(tasks["particles"], state=previous["state"])' in program
    assert 'await sim.record("cfdFlowRate"' in program
    assert 'await sim.record("sphMomentum"' in program
    assert all(item["source_code"].startswith("export default function calculate(record)")
               for item in [*boolean["calculations"], *comparison["calculations"]])


@pytest.mark.parametrize("case", ["observer-geometry", "missing-observer-name", "surface-output-target",
                                  "missing-surface", "missing-moment-origin", "invalid-contribution",
                                  "periodic-one-target", "missing-translation"])
def test_incompressible_public_build_rejects_invalid_boundary_contracts(case, incompressible_cli, tmp_path):
    repo, cli, _ = incompressible_cli
    key = "incompressible-sph-periodic-channel" if case.startswith("periodic") or case == "missing-translation" else "incompressible-boolean-channel"
    with open_catalog() as catalog:
        files = catalog.experiment(key)["sourceBundle"]["files"]
    source = files["tasks/flow.tsx"]
    if case == "observer-geometry":
        changed = re.sub(r"(methodId: 'flow.observe-surface',\s*target: )\['experiment.surface.inlet'\]",
                         r"\1['experiment.geometry.fluid']", source, count=1)
        expected = "surface"
    elif case == "missing-observer-name":
        changed = re.sub(r"name: 'inlet',?", "", source, count=1)
        expected = "name"
    elif case == "surface-output-target":
        changed = re.sub(r"(key: 'inletFlowRate',\s*target: )\['task.geometry.observation'\]",
                         r"\1['experiment.surface.inlet']", source, count=1)
        expected = "Box target"
    elif case == "missing-surface":
        changed = source.replace("surface: 'inlet', ", "", 1)
        expected = "surface"
    elif case == "missing-moment-origin":
        start = source.index("          momentOrigin:")
        end = source.index("\n          },", start) + len("\n          },")
        changed = source[:start] + source[end:]
        expected = "momentOrigin"
    elif case == "invalid-contribution":
        changed = source.replace("contribution: 'total'", "contribution: 'mixed'", 1)
        expected = "contribution"
    elif case == "periodic-one-target":
        changed = source.replace("['experiment.surface.xMinus', 'experiment.surface.xPlus']", "['experiment.surface.xMinus']", 1)
        expected = "2..2"
    else:
        start = source.index("          translation:")
        end = source.index("\n          },", start) + len("\n          },")
        changed = source[:start] + source[end:]
        expected = "translation"
    assert changed != source, case
    for name, content in files.items():
        path = tmp_path / "source" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(changed if name == "tasks/flow.tsx" else content, encoding="utf-8")
    result = subprocess.run([*cli, "experiment", "build", str(tmp_path / "source"),
                             "--out", str(tmp_path / "build"), "--vars-mode", "nominal"],
                            cwd=repo, capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert result.returncode != 0, result.stdout + result.stderr
    assert expected in result.stdout + result.stderr


@pytest.fixture(scope="module")
def comparison_calculation_input():
    def leaf(kind, unit, values, components=1):
        shape = [2, 1, 1, 2, 1, 1, components]
        labels = ["x", "y", "z"] if components == 3 else ["value"]
        return {
            "dtype": "float64", "shape": shape, "data": values,
            "quantityKind": kind, "unit": unit, "tensorOrder": 1 if components == 3 else 0,
            "axes": [{"name": "x", "ticks": [0.0625, 0.1875], "unit": "m"},
                     {"name": "y", "ticks": [0.5], "unit": "m"},
                     {"name": "z", "ticks": [0.125], "unit": "m"},
                     {"name": "time", "ticks": [0, 6], "unit": "s"},
                     {"name": "frequency", "ticks": [0], "unit": "Hz"},
                     {"name": "amplitudePhase", "ticks": ["value"]},
                     {"name": "component", "ticks": labels}],
            "boxGrid": {"version": 1, "sampling": "cell-average", "components": labels,
                        "channels": ["value"], "channelUnits": [unit],
                        "origin": [0, 0, 0], "size": [0.25, 1, 0.25],
                        "rotation": [[1, 0, 0], [0, 1, 0], [0, 0, 1]], "lengthUnit": "m",
                        "gridShape": [2, 1, 1], "source": "task", "rootId": "output"},
        }
    density = leaf("MassDensity", "kg.m-3", [1000, 1000, 500, 500])
    velocity = leaf("kinematics.Velocity", "m.s-1", [0, 0, 0, 2, 0, 0, 0, 0, 0, 4, 0, 0], 3)
    pressure = leaf("Pressure", "Pa", [100, 100, 104, 104])
    boundary = leaf("transport.VolumeFlowRate", "m3.s-1", [0, 0.25])
    boundary["shape"][0] = 1
    boundary["axes"][0]["ticks"] = [0.125]
    boundary["boxGrid"].update(sampling="aggregate", gridShape=[1, 1, 1])
    return {"cfdDensity": density, "sphDensity": deepcopy(density),
            "cfdVelocity": velocity, "sphVelocity": deepcopy(velocity),
            "cfdPressure": pressure, "sphPressure": leaf("Pressure", "Pa", [300, 300, 304, 304]),
            "sphMomentum": leaf("mechanics.LinearMomentumDensity", "kg.m-2.s-1", [0, 0, 0, 2000, 0, 0, 0, 0, 0, 2000, 0, 0], 3),
            "cfdFlowRate": boundary}


@pytest.mark.parametrize("calculation", ["Periodic channel flow comparison", "Final channel velocity profiles",
                                         "Aligned pressure comparison", "Total fluid mass"])
def test_published_cfd_sph_calculations_execute_with_occupied_and_partial_cells(calculation, incompressible_cli,
                                                                            comparison_calculation_input, tmp_path):
    repo, cli, _ = incompressible_cli
    with open_catalog() as catalog:
        definitions = catalog.experiment("incompressible-sph-periodic-channel")["calculations"]
    source = next(item["source_code"] for item in definitions if item["name"] == calculation)
    (tmp_path / "calculation.js").write_text(source, encoding="utf-8")
    (tmp_path / "input.json").write_text(json.dumps(comparison_calculation_input), encoding="utf-8")
    result = subprocess.run([*cli, "calculation", "run", str(tmp_path / "calculation.js"),
                             "--fixture", str(tmp_path / "input.json"), "--out", str(tmp_path / "result.json")],
                            cwd=repo, capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
    output = json.loads((tmp_path / "result.json").read_text(encoding="utf-8"))["output"]
    if calculation == "Periodic channel flow comparison":
        assert output["shape"] == [2, 4]
        assert output["data"][4:7] == pytest.approx([0.25, 0.5, 0.5])
    elif calculation == "Final channel velocity profiles":
        assert output["shape"] == [1, 4]
        assert output["data"][:2] == pytest.approx([8 / 3, 8 / 3])
    elif calculation == "Aligned pressure comparison":
        assert output["shape"] == [2, 3]
        assert output["data"][:3] == pytest.approx([32 ** 0.5 / 3, 32 ** 0.5 / 3, 0], abs=1e-12)
    else:
        assert output["shape"] == [2, 2]
        assert output["data"] == [46.875] * 4


@pytest.mark.parametrize("calculation,expected", [
    ("Final transient hydraulic conductance", 2), ("Boundary flow balance", 0),
    ("Obstacle force", [10, 20, 30]), ("Obstacle moment", [1, 2, 3]),
])
def test_published_boolean_calculations_use_final_samples_and_signed_loads(calculation, expected,
                                                                        incompressible_cli,
                                                                        comparison_calculation_input, tmp_path):
    repo, cli, _ = incompressible_cli
    inputs = {}
    for name, kind, unit, values in [
        ("inletFlowRate", "transport.VolumeFlowRate", "m3.s-1", [-0.1, -0.2]),
        ("outletFlowRate", "transport.VolumeFlowRate", "m3.s-1", [0.1, 0.2]),
        ("inletPressure", "Pressure", "Pa", [0.1, 0.1]),
        ("outletPressure", "Pressure", "Pa", [0, 0]),
        ("obstacleForce", "mechanics.Force", "N", [-1, -2, -3, 10, 20, 30]),
        ("obstacleMoment", "mechanics.MomentOfForce", "N.m", [-1, -2, -3, 1, 2, 3]),
    ]:
        leaf = deepcopy(comparison_calculation_input["cfdFlowRate"])
        leaf.update(quantityKind=kind, unit=unit, data=values)
        leaf["boxGrid"]["channelUnits"] = [unit]
        if len(values) == 6:
            leaf["shape"][6] = 3
            leaf["tensorOrder"] = 1
            leaf["axes"][6]["ticks"] = ["x", "y", "z"]
            leaf["boxGrid"]["components"] = ["x", "y", "z"]
        inputs[name] = leaf
    with open_catalog() as catalog:
        definitions = catalog.experiment("incompressible-boolean-channel")["calculations"]
    source = next(item["source_code"] for item in definitions if item["name"] == calculation)
    (tmp_path / "calculation.js").write_text(source, encoding="utf-8")
    (tmp_path / "input.json").write_text(json.dumps(inputs), encoding="utf-8")
    result = subprocess.run([*cli, "calculation", "run", str(tmp_path / "calculation.js"),
                             "--fixture", str(tmp_path / "input.json"), "--out", str(tmp_path / "result.json")],
                            cwd=repo, capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
    output = json.loads((tmp_path / "result.json").read_text(encoding="utf-8"))["output"]
    assert output["data"] == expected
