"""Preserve the original compression and tension reference conditions."""

import pytest

from tests.catalog_example_fixtures import run_catalog_example

pytestmark = pytest.mark.validation


@pytest.mark.asyncio
@pytest.mark.parametrize("strain", [-.2, .3], ids=["compression", "tension"])
async def test_original_uniaxial_strains_preserve_analytical_stress_reaction_energy_and_volume(catalog_builds, strain):
    measurement = catalog_builds["hyperelastic-uniaxial"]
    measurement["experiment"]["variables"]["strain"] = strain
    config = measurement["experiment"]["simulationProgram"]["tasks"]["solid"]["config"]
    config["parameters"].update(analysis="static", geometricNonlinear=True, maxIterations=40)
    config["parameters"]["relativeTolerance"]["value"] = 1e-8
    config["parameters"]["spatialResolution"].update(value=.035, unit="m")
    prescribed = next(rule for rule in config["boundaryConditions"] if rule["methodId"] == "fea.prescribed-displacement")
    prescribed["parameters"]["displacement"].update(value=[.1 * strain, 0., 0.], unit="m")
    await run_catalog_example(measurement, "hyperelastic-uniaxial")
