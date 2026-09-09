"""Exercise the SQLite-owned Fresnel sources through the public Calculation CLI."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np
import pytest
from caemble_catalog import open_catalog


@pytest.mark.parametrize("diameter_nm", [100, 150, 200])
def test_catalog_fcc_geometry_diameter_layers_and_noncontact(tmp_path, diameter_nm):
    repo = Path(__file__).resolve().parents[4]
    with open_catalog() as catalog:
        example = catalog.experiment("gold-fcc-fresnel")
    directory = tmp_path / "source"
    for name, content in example["sourceBundle"]["files"].items():
        if name == "experiment.tsx":
            content = content.replace("{ min: 100, max: 200 }", f"{{ min: {diameter_nm}, max: {diameter_nm} }}")
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
    assert experiment["variables"]["diameterNm"] == diameter_nm
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


@pytest.mark.parametrize("wavelength_nm", [800, 1500])
@pytest.mark.parametrize("scenario", ["vacuum", "gaussian", "quadrature"])
def test_catalog_fresnel_matches_complex_gaussian_and_vacuum(tmp_path, wavelength_nm, scenario):
    repo = Path(__file__).resolve().parents[4]
    with open_catalog() as catalog:
        example = catalog.experiment("gold-fcc-fresnel")
    assert len(example["calculations"]) == 8
    calculation = example["calculations"][(wavelength_nm - 800) // 100]
    source = tmp_path / "calculation.js"
    source.write_text(calculation["source_code"], encoding="utf-8")
    ticks = np.linspace(-2e-6, 2e-6, 81)
    xs = ticks if scenario != "quadrature" else (np.linspace(-1, 1, 47)**3 * 1.7e-6)
    ys = ticks if scenario != "quadrature" else (np.linspace(-1, 1, 39)**3 * 1.5e-6)
    xx, yy = np.meshgrid(xs, ys)
    waist = 0.4e-6
    radius_squared = (xx - 0.25e-6)**2 + (yy + 0.15e-6)**2
    amplitude = 0j if scenario == "vacuum" else 0.3 + 0.2j
    field = np.zeros((1, 1, len(ys), len(xs), 3), dtype=np.complex128)
    field[0, 0, :, :, 0] = amplitude * np.exp(-radius_squared / waist**2)
    if scenario == "quadrature":
        field[0, 0, :, :, 1] = (0.2 - 0.1j) * np.exp(-radius_squared / waist**2 + 1j * xx * yy / waist**2)
    zero = np.zeros_like(field.real)
    axes = [
        {"name":"frequency", "ticks":[299792458 / (wavelength_nm * 1e-9)], "unit":"Hz"},
        {"name":"z", "ticks":[-0.355e-6], "unit":"m"},
        {"name":"y", "ticks":ys.tolist(), "unit":"m"},
        {"name":"x", "ticks":xs.tolist(), "unit":"m"},
    ]
    fixture = {}
    incident_amplitude = 0.7 + 0.4j
    separation = 0.1e-6
    reference_leakage = zero + 0.001 - 0.002j
    scattered = field * incident_amplitude * np.exp(-2j*np.pi*separation/(wavelength_nm*1e-9)) + reference_leakage
    for name, values in (("scattered", scattered), ("referenceScattered", reference_leakage), ("incident", zero + np.array([incident_amplitude, 0., 0.]))):
        record_axes = [dict(axis) for axis in axes]
        if name == "incident":
            record_axes[1] = {"name":"z", "ticks":[-0.355e-6 + separation], "unit":"m"}
        for part, data in (("real", values.real), ("imag", values.imag)):
            fixture[f"{name}{wavelength_nm}.{part}"] = {
                "dtype":"float64", "shape":list(field.shape), "data":data.ravel().tolist(),
                "axes":record_axes, "tensorOrder":1, "unit":"V.m-1",
                "quantityKind":"electromagnetism.ElectricFieldStrength",
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
