"""Explicit product entry checks, excluded from low-cost collection."""
import numpy as np
import pytest
from app.solvers.structural_mechanics.model import StructuralModel, Element
from tests.hyperelastic_fixtures import MATERIAL, POINTS


@pytest.mark.asyncio
@pytest.mark.parametrize("change,match", [
    ("linear", "geometricNonlinear"), ("transient", "static analysis"), ("modal", "static analysis"),
    ("mixed", "cannot be mixed"), ("contact", "without contact"), ("link", "without contact"),
])
async def test_unsupported_fem_material_combinations_are_rejected_before_assembly(monkeypatch, change, match):
    from app.solvers.structural_mechanics import entry
    from tests.structural_fixture import solid_invocation

    case = solid_invocation()
    case.config["parameters"]["geometricNonlinear"] = change != "linear"
    if change in {"transient", "modal"}:
        case.config["parameters"]["analysis"] = change
    model = StructuralModel(np.arange(4), POINTS.copy(), [Element("tet4", np.arange(4), MATERIAL)],
                            (6 * np.arange(4)[:, None] + np.arange(3)).ravel(), np.array([], dtype=int), np.zeros((4, 6)))
    if change == "mixed":
        model.elements.append(Element("tet4", np.arange(4), {"model": "mechanics.isotropic-elastic@1"}))
    if change == "contact":
        model.contacts.append({})
    if change == "link":
        model.links.append((0, 1, np.arange(3)))

    async def geometry_model(_invocation):
        return model

    monkeypatch.setattr(entry, "build_geometry_model", geometry_model)
    with pytest.raises(ValueError, match=match):
        await entry.run(case)
