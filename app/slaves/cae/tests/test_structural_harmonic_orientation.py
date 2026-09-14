"""An exported physical face cannot have two competing semantic normals."""

import numpy as np
import pytest

from app.solvers.structural_mechanics.interfaces.harmonic_surface import harmonic_surface_motion
from tests.test_structural_harmonic import tetrahedron_motion


@pytest.mark.parametrize("within_group", [False, True])
@pytest.mark.parametrize("offset", [0, 1, 2])
@pytest.mark.parametrize("reverse", [False, True])
def test_harmonic_surface_duplicate_orientation_agreement(within_group, offset, reverse):
    model, solution = tetrahedron_motion()
    target = "experiment.surface.radiating"
    region = model.boundary_regions[target]
    original = region["faces"][0]
    duplicate = np.roll(original[::-1] if reverse else original, offset)
    targets = [target]
    if within_group:
        region["faces"] = np.vstack((original, duplicate))
    else:
        other = "experiment.surface.second"
        model.boundary_regions[other] = {**region, "faces": duplicate[None]}
        targets.append(other)
    if reverse:
        with pytest.raises(ValueError, match="same face with opposite orientations"):
            harmonic_surface_motion(model, solution, targets)
    else:
        field = harmonic_surface_motion(model, solution, targets).members["velocity"]
        np.testing.assert_array_equal(field.domain.cells["tri3"], [[0, 2, 1]])
        assert field.values.shape == (3, 2, 3)
