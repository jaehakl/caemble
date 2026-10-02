"""Explicit identities used by resource-boundary particle fixtures."""

import numpy as np, pytest


def particle_identity(count=2):
    return {
        "particle_ids": np.arange(count, dtype=np.int64),
        "material_indices": np.zeros(count, dtype=np.int32),
        "materials": ({"source": "experiment", "task": None, "name": "fixture", "definition": {}},),
    }


@pytest.fixture(scope="module", params=["dem-floor-contact", "sph-hydrostatic-column", "mpm-affine-compression"])
def particle_measurement(request, catalog_builds):
    example, grid_shape = (request.param, None) if isinstance(request.param, str) else request.param
    measurement = catalog_builds[example]
    if grid_shape is not None:
        # Only the observation density changes; the Catalog physical model is intact.
        for output in measurement["experiment"]["simulationProgram"]["tasks"]["particles"]["config"]["outputs"]:
            if output["methodId"] in ("sph.pressure", "sph.mass-density"):
                output["parameters"]["gridShape"] = list(grid_shape)
                output["boxGrid"]["gridShape"] = list(grid_shape)
    return measurement


def setup_particles(positions, velocity, *, mass=None, radius=None, damping=0, friction=(0, 0), gravity=(0, 0, 0)):
    count = len(positions)
    mass = np.ones(count) if mass is None else np.asarray(mass, dtype=float)
    radius = np.ones(count) if radius is None else np.asarray(radius, dtype=float)
    model = {"mass": mass, "radius": radius, "inertia": .4 * mass * radius**2,
             "particleIds": np.arange(count, dtype=np.int32), "materialIndices": np.zeros(count, dtype=np.int32),
             "coefficients": {"0:0": np.array([1e4, 2500, damping, damping / 2, *friction])},
             "gravity": np.asarray(gravity, dtype=float)}
    state = {"positions": np.array(positions, dtype=float), "velocity": np.array(velocity, dtype=float),
             "angularVelocity": np.zeros((count, 3)), "contactHistory": {}, "frictionDissipation": 0.0}
    return model, state
