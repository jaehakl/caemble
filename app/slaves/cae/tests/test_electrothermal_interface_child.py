"""Executable finite-resistance fixture with independent mechanical bonding."""

import numpy as np
import pytest

from app.kernel.api import InputArtifact, SolverResourceServices
from app.kernel.catalog import SolverCatalog
from app.kernel.coordinator.invocation import execute_solver
from app.kernel.coordinator.plan import TaskSpec
from app.kernel.execution import SpawnSolverExecutor
from app.solvers.structural_mechanics.continuum import integration_points
from app.solvers.structural_mechanics.materials import isotropic_elasticity
from tests.solver_chain_fixtures import world
from tests.scalar_fixtures import layered_scene


@pytest.mark.asyncio
async def test_interface_temperature_jump_survives_actual_structural_child_and_cache(tmp_path):
    shared = world()
    scene = layered_scene()
    for index, root in enumerate(scene["roots"]):
        root["node"]["child"]["parameters"]["size"] = [1., 1., .5]
        root["node"]["matrix"][11] = -.25 + index * .5
        root["material"] = {"name": root["id"]}
    scene["geometryGroups"] = [{"name": "assembly", "rootIds": ["base", "metal"]}]
    scene["surfaceGroups"] = [{"name": name, "selectors": [
        {"rootId": root, "sourceNodeId": root + "-box", "surfaceIndex": face}]}
        for name, root, face in (("bottom", "base", 4), ("top", "metal", 5),
                                 ("lowerSide", "base", 5), ("upperSide", "metal", 4))]
    shared["experiment"] = scene
    shared["materials"]["experiment"] = {name: {"models": {
        "thermal": {"model": "heat.fourier-conduction@1", "parameters": {"k": {"value": np.eye(3) * k}}},
        "elastic": {"model": "mechanics.isotropic-elastic@1", "parameters": {"E": 2e9, "nu": .3, "density": 1000.}},
        "expansion": {"model": "mechanics.isotropic-thermal-expansion@1", "parameters": {"alpha": 1e-5}},
    }} for name, k in (("base", 2.), ("metal", 4.))}
    shared["materialSelections"] = {role: {name: {group: selected} for name in ("base", "metal")}
        for role, group, selected in (("thermalDomain", "conduction", "thermal"),
                                     ("bodyDomain", "constitutive", "elastic"),
                                     ("thermalExpansionDomain", "expansion", "expansion"))}
    shared["interactions"] = {"junction": {"between": ["base", "metal"], "models": {
        "contact": {"model": "heat.constant-interface-conductance@1", "parameters": {"coefficient": 5.}}}}}
    shared["interactionSelections"] = {"thermalInterface": [
        {"between": ["base", "metal"], "interaction": "junction", "models": {"conductance": "contact"}}]}
    shared["interactionSubjects"] = {"heat.constant-interface-conductance@1": {"kind": "material-pair", "exchange": "symmetric"}}
    target = ["experiment.geometry.assembly"]
    heat = {"parameters": {"relativeTolerance": 1e-8}, "initializations": [
        {"methodId": "heat.mesh", "target": target, "parameters": {"maxElementSize": .3, "layerAxis": "z"}},
        {"methodId": "heat.body", "target": target, "parameters": {}}], "boundaryConditions": [
        {"methodId": "heat.fixed-temperature", "target": ["experiment.surface." + side], "parameters": {"temperature": temperature}}
        for side, temperature in (("bottom", 300.), ("top", 310.))], "outputs": [],
        "exports": [{"methodId": "heat.temperature", "key": "temperature", "target": target, "parameters": {}}]}
    heat["boundaryConditions"].append({"methodId": "heat.interface", "target": ["experiment.surface.lowerSide", "experiment.surface.upperSide"], "parameters": {}})
    structure = {"parameters": {"analysis": "static", "geometricNonlinear": False,
        "spatialResolution": .3, "relativeTolerance": 1e-8, "maxIterations": 30}, "initializations": [
        {"methodId": "fea.mesh", "target": target, "parameters": {"layerAxis": "z"}},
        {"methodId": "fea.body", "target": target, "parameters": {}},
        {"methodId": "fea.bonded", "target": target, "parameters": {}},
        {"methodId": "fea.thermal-expansion", "target": target, "parameters": {"stressFreeTemperature": 300.}}],
        "boundaryConditions": [{"methodId": "fea.fixed", "target": ["experiment.surface.bottom"], "parameters": {"components": ["x", "y", "z"]}}],
        "outputs": [], "exports": []}
    catalog, answers = SolverCatalog.discover(), []
    for cached in (False, True):
        resources = SolverResourceServices(geometry_cache_path=str(tmp_path) if cached else None)
        inputs = {}
        for name, version, config in (("heat-transfer", "2.0.0", heat), ("structural-mechanics", "8.0.0", structure)):
            task = {"kernel": {"name": name, "version": version}, "config": config}
            spec = TaskSpec(name, task, catalog.descriptor(name, version), catalog.locator(name, version), 3, {}, {}, {})
            transaction = await execute_solver(spec, {}, inputs, shared, None,
                executor=SpawnSolverExecutor(), resources=resources, timeout=40)
            result = transaction.value
            transaction.commit()
            if name == "heat-transfer":
                temperature = result.exports["temperature"]
                untouched = temperature.values.copy()
                assert len(np.unique(temperature.domain.metadata["parentNodeIds"])) < len(temperature.values)
                inputs["temperature"] = InputArtifact("temperature", "caemble.heat/temperature@3", name, name, version, "temperature", 0, None, temperature)
            else:
                displacement = result.visualizations["displacement"]
                source_ids = temperature.domain.metadata["parentCellIds"]
                target_ids = displacement.domain.metadata["parentCellIds"]
                order = np.argsort(source_ids)
                selected = order[np.searchsorted(source_ids[order], target_ids)]
                corners = temperature.values[temperature.domain.cells["tet4"][selected]]
                np.testing.assert_array_equal(source_ids[selected], target_ids)
                expected = []
                elasticity = isotropic_elasticity(2e9, .3)
                for nodes, values in zip(displacement.domain.cells["tet4"], corners, strict=True):
                    gradient = integration_points("tet4", displacement.domain.points[nodes])[0][1]
                    strain = gradient @ displacement.values[nodes].ravel()
                    strain[:3] -= 1e-5 * (values.mean() - 300.)
                    expected.append(elasticity @ strain)
                np.testing.assert_allclose(result.visualizations["stress"].values, expected, rtol=1e-9, atol=1e-7)
                np.testing.assert_array_equal(temperature.values, untouched)
                answers.append(displacement.values.copy())
    np.testing.assert_array_equal(*answers)
