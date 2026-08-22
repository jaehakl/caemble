from __future__ import annotations

import base64
import binascii
import hashlib
import json
import math
import struct
from datetime import date, datetime
from itertools import islice
from typing import Any, Iterable, Literal

from sqlalchemy import Text, and_, cast, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from db import (
    DesignerModel,
    Experiment,
    Material,
    MaterialName,
    MaterialParameter,
    Measurement,
    PredictorModel,
    RecordedData,
)


VisibleResource = Literal[
    "material",
    "experiment",
    "measurement",
    "recorded_data",
    "designer_model",
    "predictor_model",
]

MAX_SEARCH_RESULTS = 10
MAX_SOURCE_CHUNK = 24_000
MAX_RECORDED_VALUES = 256


class VisibleDataError(ValueError):
    pass


class VisibleDataReader:
    def __init__(self, db: AsyncSession, user_id: str):
        self.db = db
        self.user_id = user_id

    async def search(
        self,
        resource: VisibleResource,
        query: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        limit = min(max(limit, 1), MAX_SEARCH_RESULTS)
        pattern = _search_pattern(query)
        if resource == "material":
            statement = (
                select(
                    Material.id,
                    Material.description,
                    Material.color,
                    Material.updated_at,
                    MaterialName.name,
                )
                .outerjoin(
                    MaterialName,
                    and_(
                        MaterialName.material_id == Material.id,
                        _visible(MaterialName.user_id, self.user_id),
                    ),
                )
                .where(
                    _visible(Material.user_id, self.user_id),
                    or_(
                        MaterialName.name.ilike(pattern, escape="\\"),
                        Material.description.ilike(pattern, escape="\\"),
                        Material.inchi.ilike(pattern, escape="\\"),
                    ),
                )
                .order_by(Material.updated_at.desc(), Material.id.desc())
                .limit(limit)
            )
            rows = (await self.db.execute(statement)).mappings().all()
            return [
                {
                    "id": row["id"],
                    "name": row["name"] or f"Material {row['id']}",
                    "description": row["description"],
                    "color": row["color"],
                    "updatedAt": _json_value(row["updated_at"]),
                }
                for row in rows
            ]
        model, columns, searchable, visibility = self._simple_search_spec(resource)
        statement = (
            select(*columns)
            .where(
                visibility,
                or_(*(column.ilike(pattern, escape="\\") for column in searchable)),
            )
            .order_by(model.updated_at.desc(), model.id.desc())
            .limit(limit)
        )
        return [_json_mapping(row) for row in (await self.db.execute(statement)).mappings().all()]

    async def detail(self, resource: VisibleResource, resource_id: int) -> dict[str, Any]:
        if resource == "material":
            return await self._material_detail(resource_id)
        if resource == "experiment":
            row = await self._one_visible(
                select(
                    Experiment.id,
                    Experiment.name,
                    Experiment.description,
                    Experiment.namespace,
                    Experiment.repository_slug,
                    Experiment.experiment_key,
                    Experiment.version_major,
                    Experiment.version_minor,
                    Experiment.version_patch,
                    Experiment.source_hash,
                    Experiment.source_bundle,
                    Experiment.updated_at,
                ),
                Experiment,
                resource_id,
            )
            bundle = row["source_bundle"] if isinstance(row["source_bundle"], dict) else {}
            files = bundle.get("files") if isinstance(bundle.get("files"), dict) else {}
            version = f"{row['version_major']}.{row['version_minor']}.{row['version_patch']}"
            return {
                "id": row["id"],
                "name": row["name"],
                "description": row["description"],
                "namespace": row["namespace"],
                "repository": row["repository_slug"],
                "key": row["experiment_key"],
                "version": version,
                "coordinate": (
                    f"caemble:experiment/{row['namespace']}/"
                    f"{row['repository_slug']}/{row['experiment_key']}@{version}"
                ),
                "sourceHash": row["source_hash"],
                "formatVersion": bundle.get("formatVersion"),
                "files": [
                    {"path": path, "characters": len(source)}
                    for path, source in sorted(files.items())
                    if isinstance(path, str) and isinstance(source, str)
                ],
                "updatedAt": _json_value(row["updated_at"]),
            }
        if resource == "measurement":
            row = await self._one_visible(
                select(
                    Measurement.id,
                    Measurement.experiment_id,
                    Measurement.vars,
                    Measurement.material_parameters,
                    Measurement.recorded_at,
                    Measurement.updated_at,
                ),
                Measurement,
                resource_id,
                own_only=True,
            )
            return {
                **_json_mapping(row),
                "vars": _bounded_value(row["vars"]),
                "material_parameters": _bounded_value(row["material_parameters"]),
            }
        if resource == "recorded_data":
            row = await self._recorded_row(resource_id, include_data=False)
            return _json_mapping(row)
        if resource in {"designer_model", "predictor_model"}:
            model = DesignerModel if resource == "designer_model" else PredictorModel
            row = await self._one_visible(
                select(
                    model.id,
                    model.experiment_id,
                    model.file_size,
                    model.updated_at,
                ),
                model,
                resource_id,
            )
            return _json_mapping(row)
        raise VisibleDataError("Visible data resource is not supported")

    async def read_source(
        self,
        resource: Literal["experiment"],
        resource_id: int,
        path: str | None,
        offset: int,
        length: int,
    ) -> dict[str, Any]:
        length = min(max(length, 1), MAX_SOURCE_CHUNK)
        row = await self._one_visible(
            select(Experiment.id, Experiment.name, Experiment.source_hash, Experiment.source_bundle),
            Experiment,
            resource_id,
        )
        if path is None:
            raise VisibleDataError("Experiment source path is required")
        bundle = row["source_bundle"] if isinstance(row["source_bundle"], dict) else {}
        files = bundle.get("files") if isinstance(bundle.get("files"), dict) else {}
        source = files.get(path)
        if not isinstance(source, str):
            raise VisibleDataError("Visible Experiment source file was not found")
        label = f"{row['name']} / {path}"
        revision = row["source_hash"]
        if offset > len(source):
            raise VisibleDataError("Source offset is outside the file")
        content = source[offset : offset + length]
        next_offset = offset + len(content)
        return {
            "resource": resource,
            "id": resource_id,
            "path": path,
            "offset": offset,
            "totalCharacters": len(source),
            "content": content,
            "nextOffset": next_offset if next_offset < len(source) else None,
            "revision": revision,
            "provenance": _provenance(resource, resource_id, label, revision),
        }

    async def read_recorded_slice(self, resource_id: int, offset: int, count: int) -> dict[str, Any]:
        row = await self._recorded_row(resource_id, include_data=True)
        if row["data"] is None:
            raise VisibleDataError("RecordedData payload is not stored inline")
        result = slice_recorded_tensor(row["data"], row["dtype"], offset, count)
        return {
            "id": row["id"],
            "name": row["name"],
            "quantityKind": row["quantity_kind"],
            "dtype": row["dtype"],
            "dataSchema": _bounded_value(row["data_schema"]),
            **result,
            "provenance": _provenance(
                "recorded_data",
                row["id"],
                row["name"],
                _json_value(row["updated_at"]),
            ),
        }

    def _simple_search_spec(self, resource: VisibleResource) -> tuple[Any, list[Any], list[Any], Any]:
        if resource == "experiment":
            return (
                Experiment,
                [
                    Experiment.id,
                    Experiment.name,
                    Experiment.description,
                    Experiment.namespace,
                    Experiment.repository_slug,
                    Experiment.experiment_key,
                    Experiment.source_hash,
                    Experiment.updated_at,
                ],
                [
                    Experiment.name,
                    Experiment.description,
                    Experiment.namespace,
                    Experiment.repository_slug,
                    Experiment.experiment_key,
                ],
                _visible(Experiment.user_id, self.user_id),
            )
        if resource == "measurement":
            return (
                Measurement,
                [Measurement.id, Measurement.experiment_id, Measurement.recorded_at, Measurement.updated_at],
                [cast(Measurement.id, Text), cast(Measurement.experiment_id, Text)],
                Measurement.user_id == self.user_id,
            )
        if resource == "recorded_data":
            return (
                RecordedData,
                [
                    RecordedData.id,
                    RecordedData.measurement_id,
                    RecordedData.name,
                    RecordedData.quantity_kind,
                    RecordedData.dtype,
                    RecordedData.tensor_order,
                    RecordedData.file_size,
                    RecordedData.updated_at,
                ],
                [RecordedData.name, RecordedData.quantity_kind, RecordedData.dtype],
                RecordedData.user_id == self.user_id,
            )
        if resource in {"designer_model", "predictor_model"}:
            model = DesignerModel if resource == "designer_model" else PredictorModel
            return (
                model,
                [model.id, model.experiment_id, model.file_size, model.updated_at],
                [cast(model.id, Text), cast(model.experiment_id, Text)],
                _visible(model.user_id, self.user_id),
            )
        raise VisibleDataError("Visible data resource is not supported")

    async def _material_detail(self, resource_id: int) -> dict[str, Any]:
        row = await self._one_visible(
            select(Material.id, Material.inchi, Material.description, Material.color, Material.updated_at),
            Material,
            resource_id,
        )
        names = (
            await self.db.scalars(
                select(MaterialName.name)
                .where(
                    MaterialName.material_id == resource_id,
                    _visible(MaterialName.user_id, self.user_id),
                )
                .order_by(MaterialName.name)
                .limit(50)
            )
        ).all()
        parameters = (
            await self.db.execute(
                select(
                    MaterialParameter.name,
                    MaterialParameter.value,
                    MaterialParameter.source,
                    MaterialParameter.version,
                    MaterialParameter.description,
                    MaterialParameter.temperature,
                    MaterialParameter.pressure,
                    MaterialParameter.frequency,
                )
                .where(
                    MaterialParameter.material_id == resource_id,
                    _visible(MaterialParameter.user_id, self.user_id),
                )
                .order_by(MaterialParameter.name, MaterialParameter.id)
                .limit(100)
            )
        ).mappings().all()
        value = {
            **_json_mapping(row),
            "names": list(names),
            "parameters": [
                {**_json_mapping(parameter), "value": _bounded_value(parameter["value"])}
                for parameter in parameters
            ],
        }
        value["evidenceRevision"] = hashlib.sha256(
            json.dumps(
                value,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                default=str,
            ).encode("utf-8")
        ).hexdigest()
        return value

    async def _recorded_row(self, resource_id: int, *, include_data: bool) -> Any:
        columns = [
            RecordedData.id,
            RecordedData.measurement_id,
            RecordedData.name,
            RecordedData.quantity_kind,
            RecordedData.tensor_order,
            RecordedData.dtype,
            RecordedData.data_schema,
            RecordedData.file_size,
            RecordedData.updated_at,
        ]
        if include_data:
            columns.append(RecordedData.data)
        row = (
            await self.db.execute(
                select(*columns).where(
                    RecordedData.id == resource_id,
                    RecordedData.user_id == self.user_id,
                )
            )
        ).mappings().one_or_none()
        if row is None:
            raise VisibleDataError("Visible RecordedData was not found")
        return row

    async def _one_visible(
        self,
        statement: Any,
        model: Any,
        resource_id: int,
        *,
        own_only: bool = False,
    ) -> Any:
        visibility = model.user_id == self.user_id if own_only else _visible(model.user_id, self.user_id)
        row = (
            await self.db.execute(statement.where(model.id == resource_id, visibility))
        ).mappings().one_or_none()
        if row is None:
            raise VisibleDataError("Visible data was not found")
        return row


def slice_recorded_tensor(data: Any, dtype: str, offset: int, count: int) -> dict[str, Any]:
    if offset < 0:
        raise VisibleDataError("RecordedData offset must be non-negative")
    count = min(max(count, 1), MAX_RECORDED_VALUES)
    if not isinstance(data, dict):
        raise VisibleDataError("RecordedData payload is invalid")
    shape = data.get("shape")
    storage = data.get("storage")
    if not isinstance(shape, list) or not all(isinstance(value, int) and value >= 0 for value in shape):
        legacy = data.get("value")
        shape = _infer_shape(legacy)
        total = sum(1 for _ in _flatten_inline(legacy))
        return _slice_inline(legacy, shape, total, offset, count)
    total = math.prod(shape) if shape else 1
    if offset > total:
        raise VisibleDataError("RecordedData offset is outside the tensor")
    selected_count = min(count, total - offset)
    if not isinstance(storage, dict):
        raise VisibleDataError("RecordedData storage is invalid")
    if storage.get("kind") == "inline":
        return _slice_inline(storage.get("value"), shape, total, offset, count)
    if storage.get("kind") != "base64" or not isinstance(storage.get("data"), str):
        raise VisibleDataError("RecordedData storage cannot be read from the database")
    format_code = _DTYPE_FORMATS.get(dtype)
    if format_code is None:
        raise VisibleDataError("RecordedData dtype is not sliceable")
    item_size = struct.calcsize(f"<{format_code}")
    byte_length = storage.get("byteLength")
    if not isinstance(byte_length, int) or byte_length != total * item_size:
        raise VisibleDataError("RecordedData byte length is inconsistent")
    values = _decode_base64_slice(storage["data"], format_code, offset, selected_count)
    next_offset = offset + len(values)
    return {
        "shape": shape,
        "totalValues": total,
        "offset": offset,
        "values": values,
        "nextOffset": next_offset if next_offset < total else None,
    }


_DTYPE_FORMATS = {
    "bool": "?",
    "int8": "b",
    "uint8": "B",
    "int16": "h",
    "uint16": "H",
    "int32": "i",
    "uint32": "I",
    "int64": "q",
    "uint64": "Q",
    "float16": "e",
    "float32": "f",
    "float64": "d",
}


def _decode_base64_slice(encoded: str, format_code: str, offset: int, count: int) -> list[Any]:
    if count == 0:
        return []
    item_size = struct.calcsize(f"<{format_code}")
    byte_start = offset * item_size
    byte_end = byte_start + count * item_size
    character_start = (byte_start // 3) * 4
    character_end = ((byte_end + 2) // 3) * 4
    try:
        decoded = base64.b64decode(encoded[character_start:character_end], validate=True)
    except (ValueError, binascii.Error) as error:
        raise VisibleDataError("RecordedData base64 storage is invalid") from error
    local_start = byte_start - (character_start // 4) * 3
    selected = decoded[local_start : local_start + count * item_size]
    if len(selected) != count * item_size:
        raise VisibleDataError("RecordedData base64 storage is truncated")
    return list(struct.unpack(f"<{count}{format_code}", selected))


def _slice_inline(
    value: Any,
    shape: list[int],
    total: int,
    offset: int,
    count: int,
) -> dict[str, Any]:
    if offset > total:
        raise VisibleDataError("RecordedData offset is outside the tensor")
    selected_count = min(count, total - offset)
    selected = list(islice(_flatten_inline(value), offset, offset + selected_count))
    if len(selected) != selected_count:
        raise VisibleDataError("RecordedData inline shape is inconsistent")
    next_offset = offset + len(selected)
    return {
        "shape": shape,
        "totalValues": total,
        "offset": offset,
        "values": selected,
        "nextOffset": next_offset if next_offset < total else None,
    }


def _flatten_inline(value: Any, depth: int = 0) -> Iterable[Any]:
    if depth > 16:
        raise VisibleDataError("RecordedData inline nesting is too deep")
    if isinstance(value, list):
        for item in value:
            yield from _flatten_inline(item, depth + 1)
    else:
        yield value


def _infer_shape(value: Any) -> list[int]:
    shape: list[int] = []
    current = value
    while isinstance(current, list):
        shape.append(len(current))
        current = current[0] if current else None
    return shape


def _visible(column: Any, user_id: str) -> Any:
    return or_(column.is_(None), column == user_id)


def _search_pattern(query: str) -> str:
    escaped = query.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _json_mapping(row: Any) -> dict[str, Any]:
    return {key: _json_value(value) for key, value in row.items()}


def _json_value(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


def _bounded_value(value: Any) -> Any:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)
    if len(encoded.encode("utf-8")) <= 16 * 1024:
        return value
    return {"truncated": True, "preview": encoded[:8_000]}


def _provenance(
    resource: str,
    resource_id: int,
    label: str,
    revision: str | None,
) -> dict[str, Any]:
    return {
        "kind": "database",
        "label": label,
        "resourceType": resource,
        "resourceId": resource_id,
        "revision": revision,
    }
