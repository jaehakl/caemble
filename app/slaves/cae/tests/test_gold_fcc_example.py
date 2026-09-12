"""Exercise the SQLite-owned Fresnel sources through the public Calculation CLI."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np
import pytest
from caemble_catalog import open_catalog
from app.methods.geometry import GeometryService
from app.methods.structured import rasterize_mesh_cell_centers
from app.solvers.fdtd.materials import MaterialProperties
from app.solvers.fdtd.setup import _paint_material


@pytest.mark.parametrize("diameter_nm", [100, 150, 200])
def test_catalog_fcc_geometry_diameter_layers_and_noncontact(tmp_path, diameter_nm):
    repo = Path(__file__).resolve().parents[4]
    with open_catalog() as catalog:
        example = catalog.experiment("gold-fcc-fresnel")
    directory = tmp_path / "source"
    for name, content in example["sourceBundle"]["files"].items():
        if name == "experiment.tsx":
            content = content.replace("min: 100, max: 200", f"min: {diameter_nm}, max: {diameter_nm}")
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    build = tmp_path / "build"
    result = subprocess.run([
        "node", str(repo / "app/ui/dist-cli/caemble.cjs"), "experiment", "build", str(directory),
        "--vars-mode", "nominal", "--out", str(build),
    ], cwd=repo, capture_output=True, text=True, encoding="utf-8", timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    manifest = json.loads((build / "manifest.json").read_text(encoding="utf-8"))
    measurement = json.loads((build / manifest["items"][0]["file"]).read_text(encoding="utf-8"))["measurement"]
    experiment = measurement["experiment"]
    assert set(experiment["simulationProgram"]["recordedData"]) == {
        "scattered", "referenceScattered", "incident",
    }
    for layer, size in (("lower", 5), ("upper", 4)):
        np.testing.assert_array_equal(experiment["variables"][layer + "DiameterNm"], np.full((size, size), diameter_nm))
        assert experiment["varsSchema"][layer + "DiameterNm"]["shape"] == [size, size]
        assert experiment["varsSchema"][layer + "PositionOffsetNm"]["shape"] == [size, size, 3]
        for axis in ("Azimuthal", "Polar"):
            for field in ("Amplitude", "Phase"):
                assert experiment["varsSchema"][layer + axis + field]["shape"] == [size, size, 2]
    roots = experiment["scene"]["roots"]
    assert len(roots) == 41
    centers = []
    for root in roots:
        node = root["node"]
        transform = np.eye(4)
        while node["kind"] in {"transform", "instance"}:
            transform = transform @ np.array(node["matrix"]).reshape(4,4)
            node = node["child"]
        centers.append(transform[:3,3])
        primitive = node
        assert primitive["primitive"] == "curvedSurfaceSphere"
        parameters = primitive["parameters"]
        radius = parameters["azimuthalCurve"][0]["amplitude"] * sum(mode["amplitude"] for mode in parameters["polarCurve"])
        assert radius * 2000 == pytest.approx(diameter_nm)
    centers = np.array(centers)
    z, counts = np.unique(centers[:,2], return_counts=True)
    np.testing.assert_array_equal(counts, [25,16])
    np.testing.assert_allclose(z, [-0.25/(2*np.sqrt(2)), 0.25/(2*np.sqrt(2))])
    distances = np.linalg.norm(centers[:,None,:] - centers[None,:,:], axis=2)
    distances[np.diag_indices(41)] = np.inf
    assert distances.min() == pytest.approx(0.25)
    assert distances.min() > diameter_nm * 1e-3


@pytest.mark.asyncio
@pytest.mark.parametrize("scenario", ["single", "varied", "max_offsets", "collision", "touch", "interlayer"])
async def test_layer_tensor_positions_shapes_and_collision(tmp_path, scenario):
    repo = Path(__file__).resolve().parents[4]
    variables = {}
    for layer, n in (("lower", 5), ("upper", 4)):
        variables[layer + "DiameterNm"] = np.full((n, n), 150.).tolist()
        variables[layer + "PositionOffsetNm"] = np.zeros((n, n, 3)).tolist()
        for axis in ("Azimuthal", "Polar"):
            for field in ("Amplitude", "Phase"):
                variables[layer + axis + field] = np.zeros((n, n, 2)).tolist()
    if scenario == "max_offsets":
        for layer, n in (("lower", 5), ("upper", 4)):
            variables[layer+"DiameterNm"] = np.full((n, n), 200.).tolist()
            variables[layer+"PositionOffsetNm"] = np.full((n, n, 3), 50.).tolist()
            for axis in ("Azimuthal", "Polar"):
                variables[layer+axis+"Amplitude"] = np.full((n, n, 2), .04).tolist()
                variables[layer+axis+"Phase"] = np.full((n, n, 2), 1.).tolist()
    elif scenario == "single":
        variables["upperDiameterNm"][1][2] = 180
        variables["upperPositionOffsetNm"][1][2] = [50, -50, 50]
        variables["upperAzimuthalAmplitude"][1][2] = [.04, -.04]
        variables["upperPolarAmplitude"][1][2] = [-.04, .04]
        variables["upperAzimuthalPhase"][1][2] = [1.2, -.8]
        variables["upperPolarPhase"][1][2] = [-1.8, .3]
    elif scenario == "varied":
        for layer, n in (("lower", 5), ("upper", 4)):
            for x in range(n):
                for y in range(n):
                    i = x*n+y
                    variables[layer+"DiameterNm"][x][y] = 100+2*i
                    variables[layer+"PositionOffsetNm"][x][y] = [5*np.sin(i), 7*np.cos(i), 6*np.sin(i+.3)]
                    variables[layer+"AzimuthalAmplitude"][x][y] = [.04*np.sin(i), .03*np.cos(i)]
                    variables[layer+"PolarAmplitude"][x][y] = [.03*np.cos(i), -.02*np.sin(i)]
    elif scenario == "interlayer":
        variables["lowerDiameterNm"][0][0] = variables["upperDiameterNm"][0][0] = 200
        variables["lowerPositionOffsetNm"][0][0] = [50, 50, 50]
        variables["upperPositionOffsetNm"][0][0] = [-50, -50, -50]
    else:
        variables["lowerDiameterNm"][0][0] = variables["lowerDiameterNm"][1][0] = 200
        variables["lowerPositionOffsetNm"][0][0] = [50, 0, 0]
        variables["lowerPositionOffsetNm"][1][0] = [-50 if scenario == "collision" else 0, 0, 0]
    values = tmp_path / "vars.json"
    values.write_text(json.dumps(variables), encoding="utf-8")
    build = tmp_path / "build"
    result = subprocess.run([
        "node", str(repo / "app/ui/dist-cli/caemble.cjs"), "experiment", "build",
        "--example", "gold-fcc-fresnel", "--mode", "candidate", "--vars", str(values), "--out", str(build),
    ], cwd=repo, capture_output=True, text=True, encoding="utf-8", timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    measurement = json.loads((build / "items/1.json").read_text(encoding="utf-8"))["measurement"]
    scene = measurement["experiment"]["scene"]
    assert len(scene["roots"]) == 41
    service = GeometryService()
    index = 0
    for layer, n, z in (("lower", 5, -.25/(2*np.sqrt(2))), ("upper", 4, .25/(2*np.sqrt(2)))):
        for x in range(n):
            for y in range(n):
                center = np.array([(x-(n-1)/2)*.25, (y-(n-1)/2)*.25, z])
                center += np.array(variables[layer+"PositionOffsetNm"][x][y])*.001
                node = scene["roots"][index]["node"]
                transform = np.eye(4)
                while node["kind"] in {"transform", "instance"}:
                    transform = transform @ np.array(node["matrix"]).reshape(4, 4)
                    node = node["child"]
                np.testing.assert_allclose(transform[:3, 3], center, atol=1e-12)
                mesh = await service.triangular_mesh(scene, scene["roots"][index]["id"], "um")
                assert np.all(np.abs(mesh.vertices) < np.array([.75, .75, .30]) - .01)
                radius = np.linalg.norm(mesh.vertices-center, axis=1).max()
                parameters = node["parameters"]
                maxima = []
                # The example normalizes its original 32 x 24 authoring samples.
                # Analysis evaluates that same Fourier function more densely: a
                # newly resolved maximum must not be clipped or interpolated from
                # the preview merely to preserve its sampled bounding radius.
                for azimuthal_segments, polar_segments in (
                    (32, 24),
                    (parameters["azimuthalSegments"], parameters["polarSegments"]),
                ):
                    theta = 2 * np.pi * np.arange(azimuthal_segments) / azimuthal_segments
                    phi = np.pi * np.arange(1, polar_segments) / polar_segments
                    azimuthal = sum(mode["amplitude"] * np.cos(i * theta + mode["phase"]) for i, mode in enumerate(parameters["azimuthalCurve"]))
                    polar = sum(mode["amplitude"] * np.cos(i * phi + mode["phase"]) for i, mode in enumerate(parameters["polarCurve"]))
                    poles = sum(mode["amplitude"] * np.cos(i * np.array([0., np.pi]) + mode["phase"]) for i, mode in enumerate(parameters["polarCurve"]))
                    maxima.append(max(float(np.max(azimuthal[:, None] * polar)), float(np.max(azimuthal[0] * poles))))
                assert maxima[0] * 2000 == pytest.approx(variables[layer+"DiameterNm"][x][y], rel=2e-6)
                assert radius == pytest.approx(maxima[1], rel=2e-6)
                edges = np.sort(np.concatenate([mesh.triangles[:,[0,1]], mesh.triangles[:,[1,2]], mesh.triangles[:,[2,0]]]),axis=1)
                assert np.all(np.unique(edges,axis=0,return_counts=True)[1] == 2)
                index += 1

    if scenario in ("collision", "interlayer"):
        ticks = np.arange(-.65, .01, .01) + .005
        z_ticks = np.arange(-.25, .26, .01) + .005
        masks = []
        for particle in (0, 5 if scenario == "collision" else 25):
            mesh = await service.triangular_mesh(scene, scene["roots"][particle]["id"], "um")
            masks.append(await rasterize_mesh_cell_centers(mesh, ticks, ticks, z_ticks))
        assert np.any(masks[0] & masks[1])
        union = masks[0] | masks[1]
        epsilon = np.ones(union.shape)
        plasma = np.full(union.shape, np.nan)
        damping = np.full(union.shape, np.nan)
        gold = MaterialProperties(9., 1.37e16, 1e14)
        for mask in masks:
            _paint_material(mask, gold, epsilon, plasma, damping)
        np.testing.assert_array_equal(epsilon != 1, union)
        np.testing.assert_array_equal(epsilon[union], 9.)
        np.testing.assert_array_equal(plasma[union], 1.37e16)
        np.testing.assert_array_equal(damping[union], 1e14)
        assert np.all(np.isnan(plasma[~union]))
        assert np.all(np.isnan(damping[~union]))


@pytest.mark.parametrize("wavelength_nm", [1000, 1500])
@pytest.mark.parametrize("scenario", ["vacuum", "gaussian", "quadrature"])
def test_catalog_fresnel_matches_complex_gaussian_and_vacuum(tmp_path, wavelength_nm, scenario):
    repo = Path(__file__).resolve().parents[4]
    with open_catalog() as catalog:
        example = catalog.experiment("gold-fcc-fresnel")
    assert len(example["calculations"]) == 2
    calculation = example["calculations"][[1000, 1500].index(wavelength_nm)]
    source = tmp_path / "calculation.js"
    source.write_text(calculation["source_code"], encoding="utf-8")
    ticks = np.linspace(-2e-6, 2e-6, 81)
    xs = ticks if scenario != "quadrature" else np.linspace(-1.7e-6, 1.7e-6, 47)
    ys = ticks if scenario != "quadrature" else np.linspace(-1.5e-6, 1.5e-6, 39)
    xx, yy = np.meshgrid(xs, ys)
    waist = 0.4e-6
    radius_squared = (xx - 0.25e-6)**2 + (yy + 0.15e-6)**2
    amplitude = 0j if scenario == "vacuum" else 0.3 + 0.2j
    field = np.zeros((1, 1, len(ys), len(xs), 3), dtype=np.complex128)
    field[0, 0, :, :, 0] = amplitude * np.exp(-radius_squared / waist**2)
    if scenario == "quadrature":
        field[0, 0, :, :, 1] = (0.2 - 0.1j) * np.exp(-radius_squared / waist**2 + 1j * xx * yy / waist**2)
    zero = np.zeros_like(field.real)
    fixture = {}
    incident_amplitude = 0.7 + 0.4j
    separation = 0.1e-6
    reference_leakage = zero + 0.001 - 0.002j
    scattered = field * incident_amplitude * np.exp(-2j*np.pi*separation/(wavelength_nm*1e-9)) + reference_leakage
    spacing = [float(xs[1] - xs[0]), float(ys[1] - ys[0]), 1e-8]
    size = [len(xs) * spacing[0], len(ys) * spacing[1], spacing[2]]
    for name, values in (("scattered", scattered), ("referenceScattered", reference_leakage), ("incident", zero + np.array([incident_amplitude, 0., 0.]))):
        plane_z = -0.355e-6 + (separation if name == "incident" else 0)
        origin = [float(xs[0] - spacing[0] / 2), float(ys[0] - spacing[1] / 2), plane_z - spacing[2] / 2]
        vector = values[0, 0].transpose(1, 0, 2)
        polar = np.stack([np.abs(vector), np.angle(vector)], axis=-2)
        fixture[name] = {
            "dtype":"float64", "shape":[len(xs), len(ys), 1, 1, 1, 2, 3],
            "data":polar.ravel().tolist(), "tensorOrder":1, "unit":"V.m-1",
            "quantityKind":"electromagnetism.ElectricFieldStrength",
            "axes":[
                {"name":"x", "ticks":(xs - origin[0]).tolist(), "unit":"m"},
                {"name":"y", "ticks":(ys - origin[1]).tolist(), "unit":"m"},
                {"name":"z", "ticks":[spacing[2] / 2], "unit":"m"},
                {"name":"time", "ticks":[0], "unit":"s"},
                {"name":"frequency", "ticks":[299792458 / (wavelength_nm * 1e-9)], "unit":"Hz"},
                {"name":"amplitudePhase", "ticks":["amplitude", "phase"]},
                {"name":"component", "ticks":["x", "y", "z"]},
            ],
            "boxGrid":{
                "version":1, "sampling":"point", "components":["x", "y", "z"],
                "channels":["amplitude", "phase"], "channelUnits":["V.m-1", "rad"],
                "frequencyKind":"sampled", "origin":origin, "size":size,
                "rotation":[[1, 0, 0], [0, 1, 0], [0, 0, 1]], "lengthUnit":"m",
                "gridShape":[len(xs), len(ys), 1], "source":"task", "rootId":name,
            },
        }
    input_path = tmp_path / "input.json"
    input_path.write_text(json.dumps(fixture), encoding="utf-8")
    output_path = tmp_path / "output.json"
    result = subprocess.run([
        "node", str(repo / "app/ui/dist-cli/caemble.cjs"), "calculation", "run", str(source),
        "--fixture", str(input_path), "--out", str(output_path),
    ], cwd=repo, capture_output=True, text=True, encoding="utf-8", timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    output = json.loads(output_path.read_text(encoding="utf-8"))["output"]
    assert output["shape"] == [81, 81]
    assert [axis["name"] for axis in output["axes"]] == ["y", "x"]
    distance = 4.645e-6
    actual = np.asarray(output["data"]).reshape(81, 81)
    if scenario == "quadrature":
        # Independent, nonseparable direct 2D quadrature at asymmetric points.
        k = 2 * np.pi / (wavelength_nm * 1e-9)
        weights = np.outer(np.gradient(ys), np.gradient(xs))
        weights[[0,-1], :] *= 0.5
        weights[:, [0,-1]] *= 0.5
        for row, column in [(0,7), (18,60), (31,22), (40,40), (65,13), (80,79)]:
            kernel = 1j / (wavelength_nm * 1e-9 * distance) * np.exp(
                -1j * k * ((ticks[column]-xx)**2 + (ticks[row]-yy)**2) / (2*distance))
            propagated = np.sum(field[0,0,:,:,:2] * (weights*kernel)[...,None],axis=(0,1))
            propagated[0] += 1
            expected = np.sum(np.abs(propagated)**2)
            np.testing.assert_allclose(actual[row,column],expected,rtol=2e-10,atol=2e-10)
        return
    rayleigh = np.pi * waist**2 / (wavelength_nm * 1e-9)
    spread = 1 - 1j * distance / rayleigh
    gaussian = amplitude / spread * np.exp(-radius_squared / (waist**2 * spread))
    expected = np.abs(1 + gaussian)**2
    np.testing.assert_allclose(actual, expected, rtol=2e-6, atol=2e-6)
