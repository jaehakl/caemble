"""Invalid authored DEM coefficients fail during input construction."""

from copy import deepcopy

import pytest

from tests.dem_contract_fixtures import dem_contract_inputs, interaction_source


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
