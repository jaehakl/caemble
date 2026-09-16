from copy import deepcopy

import pytest

from caemble_catalog import open_catalog
from caemble_catalog.admin import validate_output_contracts
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
        structural = catalog.get_solver_manifest("structural-mechanics", "7.1.0")["descriptor"]
        assert set(structural["visualizations"]) == {"displacement", "stress", "displacementHistory", "harmonicDisplacement", "harmonicStress", "volumeRatio", "meanPressure"}
        assert {item["methodId"] for item in structural["methods"]["exports"]} == {"fea.interface", "fea.motion", "fea.harmonic-surface-motion", "fea.transient-surface-motion", "fea.deformation-gradient", "fea.first-piola-stress"}
        acoustic = catalog.get_solver_manifest("pressure-acoustics", "1.1.0")["descriptor"]
        surface = next(item for item in structural["methods"]["exports"] if item["methodId"] == "fea.harmonic-surface-motion")
        assert acoustic["inputPorts"]["surfaceMotion"]["artifactTypes"] == [surface["artifactType"]]
        assert acoustic["inputPorts"]["surfaceMotion"]["data"] == surface["data"]
        assert set(surface["data"]["members"]) == {"frequencies", "velocity"}
        assert surface["target"]["kind"] == "surface"
        assert surface["data"]["members"]["velocity"]["quantityKind"] == "kinematics.Velocity"
        ray = catalog.get_solver_manifest("ray-tracing", "2.0.0")["descriptor"]
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
        runtime = catalog.runtime_slice(solvers=[("structural-mechanics", "7.1.0")], quantity_kinds=[], material_models=[])
    quantities = {item["name"] for item in runtime["quantityKinds"]}
    assert {"Length", "Volume", "Dimensionless", "mechanics.ForceMagnitude"} <= quantities


def test_mini_contract_keeps_pressure_energy_and_native_averaging_distinct():
    with open_catalog() as catalog:
        descriptor = catalog.get_solver_manifest('structural-mechanics', '7.1.0')['descriptor']
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
        descriptor = catalog.get_solver_manifest("structural-mechanics", "7.1.0")["descriptor"]
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
