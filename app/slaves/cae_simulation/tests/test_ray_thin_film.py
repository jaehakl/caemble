"""Surface films reuse TMM at the actual medium boundary, without displacement."""

from copy import deepcopy
from types import SimpleNamespace

import numpy as np
import pytest

from app.methods.geometry.analytic import AnalyticSolid, SurfaceRef
from app.methods.optics import multilayer_stokes
from app.methods.rays.analytic import RayMetadata
from app.solvers.ray_tracing import formulation
from app.solvers.ray_tracing.formulation import Ray
from app.solvers.ray_tracing.outputs import PathCollector
from app.solvers.ray_tracing.thin_film import film_layers, surface_films


def film_context(thickness=1e-7):
    layers = [
        dict(
            thickness=dict(value=thickness, unit="m"),
            samples=[
                dict(frequency=dict(value=5e14), n=dict(value=1.38), k=dict(value=0.0))
            ],
        )
    ]
    model = dict(model="optics.thin-film-stack@1", parameters=dict(layers=layers))
    part = dict(id="glass", material=dict(name="Glass"))
    world = dict(
        materialSelections=dict(thinFilm=dict(Glass=dict(stack="film"))),
        materials=dict(experiment=dict(Glass=dict(models=dict(film=model)))),
    )
    rule = dict(
        methodId="ray.thin-film-stack",
        target=["experiment.surface.coating"],
        parameters={},
    )
    context = SimpleNamespace(world=world, config=dict(boundaryConditions=[rule]))
    scene = dict(
        roots=[part],
        surfaceGroups=[
            dict(
                name="coating",
                selectors=[dict(rootId="glass", sourceNodeId="face", surfaceIndex=2)],
            )
        ],
    )
    part["node"] = dict(kind="primitive", primitive="cylinder", nodeId="face", parameters=dict(radius=1, radius_2=1, height=1))
    return context, scene, {"glass": AnalyticSolid(part)}, layers



@pytest.mark.parametrize("thickness", [0.0, -1e-9, 50e-6, 51e-6, np.inf, np.nan])
def test_thickness_exclusive_limit(thickness):
    context, scene, solids, _ = film_context(thickness)
    with pytest.raises(ValueError, match="50 micrometers"):
        surface_films(context, scene, solids, set())


def test_duplicate_conflicting_surfaces_and_constant_frequency_samples():
    context, scene, solids, layers = film_context(49.999e-6)
    result = surface_films(context, scene, solids, set())
    assert result[SurfaceRef("glass", "face", 2)] is layers
    assert film_layers(layers, 400e-9) == film_layers(layers, 800e-9)
    # Geometry scaling does not participate in the physical film definition.
    solids["glass"] = AnalyticSolid(scene["roots"][0], scale=1000)
    assert (
        surface_films(context, scene, solids, set())[SurfaceRef("glass", "face", 2)][0]["thickness"][
            "value"
        ]
        == 49.999e-6
    )
    with pytest.raises(ValueError, match="detectors or gratings"):
        surface_films(context, scene, solids, {SurfaceRef("glass", "face", 2)})
    context.config["boundaryConditions"] *= 2
    with pytest.raises(ValueError, match="duplicate"):
        surface_films(context, scene, solids, set())
    context.config["boundaryConditions"] = context.config["boundaryConditions"][:1]
    layers[0]["samples"] *= 2
    with pytest.raises(ValueError, match="increasing"):
        surface_films(context, scene, solids, set())


def test_existing_tmm_quarter_wave_reference_and_absorption():
    wavelength = 550e-9
    n = np.sqrt(1.5)
    reflected, transmitted, _ = multilayer_stokes(
        np.array([1.0, 0.2, 0.3, 0.1]),
        np.array([1.0, 0, 0]),
        np.array([0.0, 0, -1]),
        np.array([0.0, 0, 1]),
        1.0,
        [(n, wavelength / (4 * n))],
        1.5,
        wavelength,
    )
    assert reflected[0] == pytest.approx(0, abs=1e-14)
    assert transmitted[0] == pytest.approx(1, abs=1e-14)
    reflected, transmitted, _ = multilayer_stokes(
        np.array([1.0, 0, 0, 0]),
        np.array([1.0, 0, 0]),
        np.array([0.0, 0, -1]),
        np.array([0.0, 0, 1]),
        1.0,
        [(1.7 - 0.2j, 1e-7)],
        1.5,
        wavelength,
    )
    assert 0 < reflected[0] + transmitted[0] < 1


@pytest.mark.parametrize("entering", [True, False])
def test_layer_order_medium_transition_scatter_and_exit_position(monkeypatch, entering):
    _, _, _, layers = film_context()
    second = deepcopy(layers[0])
    second["samples"][0]["n"]["value"] = 2.1
    second["thickness"]["value"] = 2e-7
    layers.append(second)
    normal = np.array([0.0, 0.0, 1.0])
    direction = -normal if entering else normal
    hit = SimpleNamespace(
        position=np.zeros(3),
        normal=normal,
        distance=1.0,
        metadata=RayMetadata("glass", "Glass"),
        surface_ref=SurfaceRef("glass", "face", 2),
        crossing_kind="enter" if entering else "exit",
    )
    collision = SimpleNamespace(intersect=lambda *args, **kwargs: hit, diagonal=2.0)
    stack = (
        [("water", "Water")] if entering else [("water", "Water"), ("glass", "Glass")]
    )
    ray = Ray(
        -direction,
        direction,
        np.array([1.0, 0, 0]),
        np.array([1.0, 0, 0, 0]),
        550e-9,
        1.0,
        0,
        medium_name="Water" if entering else "Glass",
        medium_root=stack[-1][0],
        medium_stack=stack,
    )
    monkeypatch.setattr(
        formulation,
        "optical_material",
        lambda world, name, wavelength: SimpleNamespace(
            refractive_index=1.33 if name == "Water" else 1.5,
            absorption_coefficient=0.0,
            scattering_coefficient=0.0,
        ),
    )
    captured = {}
    original = formulation.multilayer_stokes

    def tmm(*args):
        captured["media"] = args[4], args[6]
        captured["layers"] = args[5]
        return original(*args)

    monkeypatch.setattr(formulation, "multilayer_stokes", tmm)
    scatter = ("lambertian", {})

    def continuation(*args):
        captured["position"] = args[7]
        captured["stack"] = args[11]
        captured["scatter"] = args[12]
        return []

    monkeypatch.setattr(formulation, "_continue_interface", continuation)
    formulation._trace_one(
        ray,
        collision,
        {},
        {},
        {},
        {SurfaceRef("glass", "face", 2): scatter},
        {},
        {},
        10,
        1e-8,
        1,
        PathCollector(20),
        {SurfaceRef("glass", "face", 2): layers},
    )
    assert captured["media"] == ((1.33, 1.5) if entering else (1.5, 1.33))
    expected = film_layers(layers, 550e-9)
    assert captured["layers"] == (expected if entering else expected[::-1])
    assert captured["stack"] == (
        [("water", "Water"), ("glass", "Glass")] if entering else [("water", "Water")]
    )
    np.testing.assert_array_equal(captured["position"], hit.position)
    assert captured["scatter"] == scatter
