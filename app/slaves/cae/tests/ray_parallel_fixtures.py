"""Ray inputs for parallel regression and explicit CPU benchmarks."""
import numpy as np
from app.kernel.api import SolverInvocation
from app.kernel.catalog import SolverCatalog
from app.kernel.coordinator.plan import RunPlan, detached


def continuous_ray_invocation(catalog_builds):
    measurement = catalog_builds["continuous-ray-optics"]
    program = measurement["experiment"]["simulationProgram"]
    plan = RunPlan.prepare(measurement, program["tasks"], program["recordedData"])
    spec = plan.task_specs["trace"]
    config = detached(spec.task["config"])
    for source in config["initializations"]:
        if "rayCount" in source["parameters"]:
            value = source["parameters"]["rayCount"]
            if isinstance(value, dict):
                value["value"] *= 6
            else:
                source["parameters"]["rayCount"] *= 6
    config["parameters"]["maxPaths"] = {"value": 17}
    invocation = SolverInvocation(config=config, state={}, inputs={}, world=plan.world(spec),
                                  geometry=None, progress=None, descriptor=detached(spec.descriptor))
    return invocation


def scattering_ray_invocation(count=512, maximum_paths=2048):
    roots = []
    for name, z, size in (("emitter", -2, [.1, .1, .1]), ("glass", 0, [2, 2, 1]), ("detector", 2, [4, 4, .1])):
        matrix = np.eye(4)
        matrix[2, 3] = z
        roots.append({"id": name, "node": {"kind": "transform", "nodeId": name + "-placement",
                      "matrix": matrix.ravel().tolist(), "child": {"kind": "primitive", "primitive": "box",
                      "nodeId": name, "parameters": {"size": size}}}})
    roots[1]["material"] = {"name": "Glass"}
    scene = {"version": 2, "geometryHash": "parallel-optics", "lengthUnit": "m", "roots": roots,
             "geometryGroups": [{"name": "domain", "rootIds": ["glass", "detector"]},
                                {"name": "medium", "rootIds": ["glass"]}],
             "surfaceGroups": [{"name": name, "selectors": [{"rootId": name, "sourceNodeId": name,
                                                             "surfaceIndex": 5 if name == "emitter" else 4}]}
                               for name in ("emitter", "glass", "detector")]}
    models = {
        "index": {"model": "optics.constant-complex-index@1", "parameters": {"n": {"value": 1.5}, "k": {"value": 0}}},
        "scatter": {"model": "optics.constant-scattering@1", "parameters": {"sigma": {"value": 2.0}}},
        "absorption": {"model": "optics.constant-absorption@1", "parameters": {"alpha": {"value": .1}}},
        "film": {"model": "optics.thin-film-stack@1", "parameters": {"layers": [
            {"thickness": {"value": 1e-7, "unit": "m"}, "samples": [
                {"frequency": {"value": 5e14}, "n": {"value": 1.38}, "k": {"value": 0}}]}]}},
    }
    world = {"experiment": scene, "task": {}, "materials": {"experiment": {"Glass": {"models": models}}},
             "materialSelections": {"opticalDomain": {"Glass": {"opticalResponse": "index", "scattering": "scatter", "absorption": "absorption"}},
                                    "thinFilm": {"Glass": {"stack": "film"}}}}
    config = {"parameters": {"seed": 42, "maxInteractions": 12, "maxPaths": maximum_paths, "minPowerFraction": {"value": 1e-6}},
              "initializations": [
                  {"methodId": "ray.domain", "target": ["experiment.geometry.domain"], "parameters": {}},
                  {"methodId": "ray.directional-source", "target": ["experiment.surface.emitter"],
                   "parameters": {"wavelength": {"value": 550e-9}, "radiantFlux": {"value": 1}, "rayCount": count,
                                  "stokes": {"value": [1, 0, 0, 0]}, "direction": {"value": [0, 0, 1]}}}],
              "boundaryConditions": [
                  {"methodId": "ray.absorbing-detector", "target": ["experiment.surface.detector"], "parameters": {}},
                  {"methodId": "ray.thin-film-stack", "target": ["experiment.surface.glass"], "parameters": {}},
                  {"methodId": "ray.lambertian-scatter", "target": ["experiment.surface.glass"], "parameters": {"scatterFraction": {"value": .5}}},
                  {"methodId": "ray.hg-medium", "target": ["experiment.geometry.medium"], "parameters": {"anisotropy": {"value": .2}}}],
              "outputs": []}
    return SolverInvocation(config=config, state={}, inputs={}, world=world, geometry=None, progress=None,
                            descriptor=SolverCatalog.discover().descriptor("ray-tracing", "4.0.0"))
