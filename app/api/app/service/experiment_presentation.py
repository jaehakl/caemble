"""Mutable presentation metadata, independent of immutable Experiment source."""
import hashlib
import json
import math
from typing import Annotated, Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, JsonValue, StrictInt, TypeAdapter, field_validator, model_validator
from sqlalchemy import select

from db import Experiment, ExperimentThumbnail, Measurement
from service.experiment_access import experiment_is_demo, require_experiment_write
from service.experiment_save_assets import thumbnail_bytes
from utils.crud.common import is_admin_user


class CameraPose(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    position: Annotated[list[float], Field(min_length=3, max_length=3)]
    target: Annotated[list[float], Field(min_length=3, max_length=3)]
    up: Annotated[list[float], Field(min_length=3, max_length=3)]
    fov: Annotated[float, Field(gt=0, lt=math.pi)]

    @model_validator(mode="after")
    def nondegenerate(self):
        direction = [a - b for a, b in zip(self.position, self.target)]
        cross = [direction[1] * self.up[2] - direction[2] * self.up[1],
                 direction[2] * self.up[0] - direction[0] * self.up[2],
                 direction[0] * self.up[1] - direction[1] * self.up[0]]
        if not any(cross):
            raise ValueError("Camera direction and up must be nonzero and independent")
        return self


Finite = Annotated[float, Field(allow_inf_nan=False)]
Nonnegative = Annotated[Finite, Field(ge=0)]
Positive = Annotated[Finite, Field(gt=0)]
Index = Annotated[StrictInt, Field(ge=0)]
Axis = Literal["x", "y", "z", "time", "frequency"]


class MeshView(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    component: Index | Literal["magnitude", "vonMises", "material"]
    wireframe: bool
    overlays: bool
    clipAxis: Literal[-1, 0, 1, 2]
    clipFraction: Annotated[float, Field(ge=0, le=1)]
    deformationScale: Nonnegative
    compareOriginal: bool = False
    referenceClip: bool = False


class Reduction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    method: Literal["index", "sum", "mean", "min", "max", "median", "std"]
    index: Index = 0


# Matches durable display controls; runtime busy, frequency discovery and picking are excluded.
SETTING_TYPES = {
    "selectedOutput": Annotated[str, Field(max_length=512)],
    "geometryMode": Literal[0, 0.5, 0.9],
    "visualizations": dict[str, Annotated[str, Field(max_length=512)]],
    "experimentVisible": bool,
    "taskVisible": bool,
    "xrayEnabled": bool,
    "overlay": list[Annotated[str, Field(max_length=512)]],
    "box.wavelength": bool,
    "box.kind": Literal["cloud", "heatmap", "line", "histogram"],
    "box.axes": Annotated[list[Axis], Field(max_length=3)],
    "box.representation": Literal["amplitude", "phase"],
    "box.component": Index | Literal["magnitude", "arrows"],
    "box.reduce": dict[Axis, Reduction],
    "box.overlay": bool,
    "box.geometryOpacity": Annotated[Finite, Field(ge=0, le=1)],
    "box.bins": Annotated[StrictInt, Field(gt=0)],
    "box.animation": Literal["off", "oscillation", "time", "frequency"],
    "box.timeSeconds": Nonnegative,
    "box.frameIndex": Index,
    "box.durationSeconds": Positive | None,
    "box.playing": bool,
    "box.repeat": bool,
    "box.speed": Positive,
    "box.fixed": Annotated[list[Finite], Field(min_length=2, max_length=2)] | None,
    "mesh.view": MeshView,
    "mesh.selectedDisplacement": str | None,
    "mesh.deformed": bool,
    "mesh.scaleMode": Literal["auto", "manual"],
    "mesh.manualScale": Nonnegative,
    "mesh.frequencyHz": Nonnegative,
    "mesh.phaseDegrees": Finite,
    "mesh.frameIndex": Index,
    "meshPlayback.playing": bool,
    "meshPlayback.repeat": bool,
    "meshPlayback.speed": Positive,
    "meshTransform.time": Finite,
    "particles.time": Finite,
    "particles.attribute": str,
    "particles.component": Index | Literal["magnitude"],
    "particles.id": Index,
    "particles.pointSize": Positive,
    "particles.geometry": bool,
    "tensor.representation": Literal["abs", "re", "im", "arg"],
    "tensor.member": str,
    "tensor.indices": dict[Annotated[str, Field(pattern=r"^[0-9]+$")], Index],
    "tensor.axes": Annotated[list[Index], Field(max_length=2)] | None,
}
SETTING_VALIDATORS = {name: TypeAdapter(value) for name, value in SETTING_TYPES.items()}


class ViewerSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    settings: dict[str, JsonValue]
    camera: CameraPose | None = None

    @field_validator("settings")
    @classmethod
    def validate_settings(cls, values):
        if len(values) > 512 or len(json.dumps(values, allow_nan=False).encode("utf-8")) > 65536:
            raise ValueError("Viewer settings exceed 512 entries or 64 KiB")
        for key, value in values.items():
            if len(key) > 600 or ":" not in key:
                raise ValueError("Invalid Viewer setting key")
            scope, name = key.rsplit(":", 1)
            if (scope == "@workspace") != (name in {"selectedOutput", "geometryMode", "visualizations", "experimentVisible", "taskVisible", "xrayEnabled"}):
                raise ValueError("Invalid Viewer setting scope")
            validator = SETTING_VALIDATORS.get(name)
            if validator is None:
                raise ValueError(f"Unknown Viewer setting: {name}")
            validator.validate_python(value, strict=True)
            if name in {"box.axes", "tensor.axes"} and value is not None and len(set(value)) != len(value):
                raise ValueError("Viewer axes must be distinct")
            if name == "box.fixed" and value is not None and value[0] >= value[1]:
                raise ValueError("Viewer range must have minimum < maximum")
        return values


class ViewerDefaults(ViewerSettings):
    version: Literal[1] = 1
    selectedResult: Annotated[str, Field(max_length=512)]


class ViewerDefaultsV2(ViewerSettings):
    version: Literal[2]
    geometryMode: Literal[0, 0.5, 0.9]
    selectedOutput: Annotated[str, Field(max_length=512)]
    visualizations: dict[str, Annotated[str, Field(max_length=512)]]


class ExperimentInitialView(ViewerDefaults):
    measurementId: Annotated[StrictInt, Field(gt=0)]


class ExperimentInitialViewV2(ViewerDefaultsV2):
    measurementId: Annotated[StrictInt, Field(gt=0)]


class PresentationUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    initialView: ExperimentInitialView | ExperimentInitialViewV2 | None = None
    thumbnail: Annotated[str, Field(max_length=700000)] | None = None

    @model_validator(mode="after")
    def require_change(self):
        if not self.model_fields_set or ("thumbnail" in self.model_fields_set and self.thumbnail is None):
            raise ValueError("Supply initialView or a thumbnail image")
        return self


async def update_presentation(db, experiment_id: int, request: PresentationUpdateRequest, *, user):
    await require_experiment_write(db, experiment_id, user)
    experiment = await db.scalar(select(Experiment).where(Experiment.id == experiment_id).with_for_update())
    if experiment is None:
        raise HTTPException(404, "Experiment not found.")
    if not is_admin_user(user) and await experiment_is_demo(db, experiment_id):
        raise HTTPException(403, "Demo 설정은 관리자만 변경할 수 있습니다.")
    image = thumbnail_bytes(request.thumbnail) if "thumbnail" in request.model_fields_set else None
    if "initialView" in request.model_fields_set:
        initial = request.initialView
        if initial is not None:
            measurement = await db.scalar(select(Measurement).where(Measurement.id == initial.measurementId).with_for_update())
            if measurement is None or measurement.experiment_id != experiment_id or measurement.recorded_at is None:
                raise HTTPException(422, "해당 Experiment의 저장 결과가 있는 Measurement를 선택하세요.")
        experiment.initial_measurement_id = initial.measurementId if initial else None
        experiment.viewer_defaults = initial.model_dump(exclude={"measurementId"}) if initial else None
    if image is not None:
        thumbnail = await db.get(ExperimentThumbnail, experiment_id)
        if thumbnail is None:
            thumbnail = ExperimentThumbnail(experiment_id=experiment_id)
            db.add(thumbnail)
        thumbnail.data = image
        thumbnail.sha256 = hashlib.sha256(image).hexdigest()
        experiment.thumbnail_url = f"/experiment/{experiment_id}/thumbnail?v={thumbnail.sha256}"
    await db.flush()
    result = {"id": experiment.id, "initial_measurement_id": experiment.initial_measurement_id,
              "viewer_defaults": experiment.viewer_defaults, "thumbnail_url": experiment.thumbnail_url}
    await db.commit()
    return result
