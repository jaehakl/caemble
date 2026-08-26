from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import numpy as np

from app.methods.geometry import TriangularMesh
from app.methods.optics import perpendicular
from app.methods.rays import typed_ray_path_bundle
from app.methods.structured import STRUCTURED_GRID_KIND, structured_cell_field
from app.runtime_kernel.api.world import target_group

from .domain import surface_triangle_keys

PATH_OUTPUT_METHOD = "ray.paths"
DETECTOR_OUTPUT_METHODS = frozenset(
    {"ray.detector-power", "ray.detector-efficiency", "ray.detector-irradiance"}
)


@dataclass(slots=True)
class Detector:
    output: dict[str, Any]
    triangle_keys: set[tuple[str, int]]
    normal: np.ndarray[Any, Any]
    u_axis: np.ndarray[Any, Any]
    v_axis: np.ndarray[Any, Any]
    minimum_u: float
    minimum_v: float
    extent_u: float
    extent_v: float
    shape: tuple[int, int]
    power: np.ndarray[Any, Any]

    def deposit(self, position: np.ndarray[Any, Any], value: float) -> None:
        u_value = float(np.dot(position, self.u_axis))
        v_value = float(np.dot(position, self.v_axis))
        column = min(self.shape[1] - 1, max(0, int((u_value - self.minimum_u) / self.extent_u * self.shape[1])))
        row = min(self.shape[0] - 1, max(0, int((v_value - self.minimum_v) / self.extent_v * self.shape[0])))
        self.power[row, column] += value


@dataclass(slots=True)
class PathCollector:
    maximum_paths: int
    paths: list[Any] = field(default_factory=list)
    detected_power: float = 0.0

    def finish(self, ray: Any) -> None:
        if len(self.paths) < self.maximum_paths and len(ray.vertices) >= 2:
            self.paths.append(ray)

    def bundle(self) -> dict[str, Any]:
        vertices: list[np.ndarray[Any, Any]] = []
        offsets = [0]
        powers: list[float] = []
        path_wavelengths: list[float] = []
        events: list[int] = []
        for path in self.paths:
            vertices.extend(path.vertices)
            offsets.append(len(vertices))
            powers.extend(path.powers)
            path_wavelengths.append(path.wavelength)
            events.extend(path.events)
        return {
            "vertices": {
                "value": np.asarray(vertices, dtype=np.float32).reshape((-1, 3)),
                "axes": [{"implicitOrdinal": True}, {"ticks": ["x", "y", "z"]}],
            },
            "pathOffsets": {
                "value": np.asarray(offsets, dtype=np.uint32),
                "axes": [{"implicitOrdinal": True}],
            },
            "segmentPower": {
                "value": np.asarray(powers, dtype=np.float32),
                "axes": [{"implicitOrdinal": True}],
            },
            "pathWavelength": {
                "value": np.asarray(path_wavelengths, dtype=np.float32),
                "axes": [{"implicitOrdinal": True}],
            },
            "segmentEvent": {
                "value": np.asarray(events, dtype=np.uint8),
                "axes": [{"implicitOrdinal": True}],
            },
        }


def build_detectors(
    config: dict[str, Any],
    scene: dict[str, Any],
    meshes: dict[str, TriangularMesh],
) -> list[Detector]:
    result: list[Detector] = []
    for output in config["outputs"]:
        method = output["methodId"]
        if method not in DETECTOR_OUTPUT_METHODS:
            continue
        keys = surface_triangle_keys(scene, target_group(output, "surface"), meshes)
        triangles = [
            meshes[root_id].vertices[meshes[root_id].triangles[triangle_index]]
            for root_id, triangle_index in keys
        ]
        triangle_values = np.asarray(triangles, dtype=np.float64)
        crosses = np.cross(
            triangle_values[:, 1] - triangle_values[:, 0],
            triangle_values[:, 2] - triangle_values[:, 0],
        )
        lengths = np.linalg.norm(crosses, axis=1)
        normal = (crosses / lengths[:, None])[0]
        points = triangle_values.reshape((-1, 3))
        u_axis = perpendicular(normal)
        v_axis = np.cross(normal, u_axis)
        u_values = points @ u_axis
        v_values = points @ v_axis
        extent_u = float(np.ptp(u_values))
        extent_v = float(np.ptp(v_values))
        shape = (1, 1)
        if method == "ray.detector-irradiance":
            shape_values = output["parameters"]["pixelShape"]
            shape_values = shape_values.get("value") if isinstance(shape_values, dict) else shape_values
            if isinstance(shape_values, np.ndarray):
                shape_values = shape_values.tolist()
            shape = (int(shape_values[0]), int(shape_values[1]))
        result.append(
            Detector(
                output,
                keys,
                normal,
                u_axis,
                v_axis,
                float(np.min(u_values)),
                float(np.min(v_values)),
                extent_u,
                extent_v,
                shape,
                np.zeros(shape, dtype=np.float64),
            )
        )
    return result


async def build_ray_outputs(
    config: dict[str, Any],
    detectors: list[Detector],
    total_source_power: float,
    path_bundle: dict[str, Any],
    progress: Callable[[Any], Awaitable[None]],
    descriptor: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    artifacts: dict[str, Any] = {}
    detector_by_key = {detector.output["key"]: detector for detector in detectors}
    outputs = config["outputs"]
    for index, output in enumerate(outputs):
        method = output["methodId"]
        key = output["key"]
        if method == PATH_OUTPUT_METHOD:
            artifacts[key] = typed_ray_path_bundle(path_bundle)
        elif method in DETECTOR_OUTPUT_METHODS:
            detector = detector_by_key[key]
            detected_power = float(np.sum(detector.power))
            if method == "ray.detector-power":
                artifacts[key] = {"value": detected_power}
            elif method == "ray.detector-efficiency":
                artifacts[key] = {
                    "value": detected_power / total_source_power if total_source_power > 0 else 0.0
                }
            else:
                pixel_area = detector.extent_u * detector.extent_v / math.prod(detector.shape)
                u_ticks = (
                    detector.minimum_u
                    + (np.arange(detector.shape[1]) + 0.5) * detector.extent_u / detector.shape[1]
                )
                v_ticks = (
                    detector.minimum_v
                    + (np.arange(detector.shape[0]) + 0.5) * detector.extent_v / detector.shape[0]
                )
                axes = [
                    {
                        "ticks": v_ticks.tolist(),
                        "spacing": detector.extent_v / detector.shape[0],
                    },
                    {
                        "ticks": u_ticks.tolist(),
                        "spacing": detector.extent_u / detector.shape[1],
                    },
                ]
                if descriptor is None:
                    artifacts[key] = {
                        "value": detector.power / pixel_area,
                        "axes": axes,
                    }
                else:
                    data = next(
                        item.get("data", {})
                        for item in descriptor["methods"]["outputs"]
                        if item["methodId"] == method
                    )
                    artifacts[key] = structured_cell_field(
                        _detector_domain_ref(
                            detector,
                            axes,
                            descriptor["referenceLengthUnit"],
                        ),
                        detector.power / pixel_area,
                        axes,
                        quantity_kind=data.get("quantityKind"),
                        unit=data.get("unit"),
                    )
        await progress({"stage": "output", "completed": index + 1, "total": len(outputs)})
    return artifacts


def _detector_domain_ref(
    detector: Detector,
    axes: list[dict[str, Any]],
    reference_length_unit: str,
) -> dict[str, Any]:
    signature = {
        "triangleKeys": sorted([list(key) for key in detector.triangle_keys]),
        "shape": list(detector.shape),
        "axes": axes,
        "normal": detector.normal.tolist(),
        "uAxis": detector.u_axis.tolist(),
        "vAxis": detector.v_axis.tolist(),
        "referenceLengthUnit": reference_length_unit,
    }
    identity = hashlib.sha256(
        json.dumps(signature, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return {"kind": STRUCTURED_GRID_KIND, "id": identity, **signature}
