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
        structural = catalog.get_solver_manifest("structural-mechanics", "5.0.0")["descriptor"]
        assert set(structural["visualizations"]) == {"displacement", "stress", "displacementHistory"}
        assert {item["methodId"] for item in structural["methods"]["exports"]} == {"fea.interface", "fea.motion"}
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
        runtime = catalog.runtime_slice(solvers=[("structural-mechanics", "5.0.0")], quantity_kinds=[], material_models=[])
    quantities = {item["name"] for item in runtime["quantityKinds"]}
    assert {"Length", "Volume", "Dimensionless", "mechanics.ForceMagnitude"} <= quantities
