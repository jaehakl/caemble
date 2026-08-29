from __future__ import annotations

import base64
import hashlib
import math
import struct
from datetime import date, datetime
from itertools import islice
from typing import Any, Iterable

from sqlalchemy import Text, and_, cast, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from db import (
    Calculation,
    Experiment,
    ExperimentRecord,
    Material,
    MaterialName,
    MaterialParameter,
    Measurement,
    RecordedData,
)


VisibleResource = str


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
        if resource == "calculation":
            statement = (
                select(
                    Calculation.id,
                    Calculation.experiment_id,
                    Calculation.name,
                    Calculation.description,
                    Calculation.updated_at,
                )
                .join(Experiment, Experiment.id == Calculation.experiment_id)
                .where(
                    _visible(Experiment.user_id, self.user_id),
                    or_(
                        Calculation.name.ilike(pattern, escape="\\"),
                        Calculation.description.ilike(pattern, escape="\\"),
                    ),
                )
                .order_by(Calculation.updated_at.desc(), Calculation.id.desc())
                .limit(limit)
            )
            return [
                _json_mapping(row)
                for row in (await self.db.execute(statement)).mappings().all()
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
        if resource == "recorded_data":
            statement = statement.join(
                ExperimentRecord,
                ExperimentRecord.id == RecordedData.experiment_record_id,
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
                "files": [
                    {"path": path, "characters": len(source)}
                    for path, source in sorted(files.items())
                    if isinstance(path, str) and isinstance(source, str)
                ],
                "updatedAt": _json_value(row["updated_at"]),
            }
        if resource == "calculation":
            row = (
                await self.db.execute(
                    select(
                        Calculation.id,
                        Calculation.experiment_id,
                        Calculation.name,
                        Calculation.description,
                        Calculation.source_code,
                        Calculation.updated_at,
                    )
                    .join(Experiment, Experiment.id == Calculation.experiment_id)
                    .where(
                        Calculation.id == resource_id,
                        _visible(Experiment.user_id, self.user_id),
                    )
                )
            ).mappings().one_or_none()
            if row is None:
                raise VisibleDataError("Visible Calculation was not found")
            return {
                "id": row["id"],
                "experimentId": row["experiment_id"],
                "name": row["name"],
                "description": row["description"],
                "sourceCharacters": len(row["source_code"]),
                "sourceSha256": _text_hash(row["source_code"]),
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
            recorded_rows = (
                await self.db.execute(
                    select(
                        RecordedData.id,
                        ExperimentRecord.name,
                        ExperimentRecord.quantity_kind,
                        ExperimentRecord.tensor_order,
                        ExperimentRecord.dtype,
                        ExperimentRecord.data_schema,
                        RecordedData.file_size,
                    )
                    .join(
                        ExperimentRecord,
                        ExperimentRecord.id == RecordedData.experiment_record_id,
                    )
                    .where(
                        RecordedData.measurement_id == resource_id,
                        RecordedData.user_id == self.user_id,
                    )
                    .order_by(ExperimentRecord.name, RecordedData.id)
                )
            ).mappings().all()
            return {
                **_json_mapping(row),
                "vars": _bounded_value(row["vars"]),
                "material_parameters": _bounded_value(row["material_parameters"]),
                "recordedData": [_json_mapping(item) for item in recorded_rows],
            }
        if resource == "recorded_data":
            row = await self._recorded_row(resource_id, include_data=False)
            return _json_mapping(row)
        raise VisibleDataError("Visible data resource is not supported")

    async def read_source(
        self,
        resource: str,
        resource_id: int,
        path: str | None,
        offset: int,
        length: int,
    ) -> dict[str, Any]:
        if resource == "calculation":
            row = (
                await self.db.execute(
                    select(Calculation.id, Calculation.name, Calculation.source_code)
                    .join(Experiment, Experiment.id == Calculation.experiment_id)
                    .where(
                        Calculation.id == resource_id,
                        _visible(Experiment.user_id, self.user_id),
                    )
                )
            ).mappings().one_or_none()
            if row is None:
                raise VisibleDataError("Visible Calculation was not found")
            if path is not None:
                raise VisibleDataError("Calculation source path must be null")
            source = row["source_code"]
            if offset > len(source):
                raise VisibleDataError("Source offset is outside the Calculation")
            content = source[offset : offset + length]
            next_offset = offset + len(content)
            return {
                "resource": resource,
                "id": resource_id,
                "path": None,
                "sha256": _text_hash(source),
                "offset": offset,
                "totalCharacters": len(source),
                "content": content,
                "nextOffset": next_offset if next_offset < len(source) else None,
                "provenance": _provenance(resource, resource_id, row["name"]),
            }
        if resource != "experiment":
            raise VisibleDataError("Visible source resource is not supported")
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
            "provenance": _provenance(resource, resource_id, label),
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
                    ExperimentRecord.name,
                    ExperimentRecord.quantity_kind,
                    ExperimentRecord.dtype,
                    ExperimentRecord.tensor_order,
                    RecordedData.file_size,
                    RecordedData.updated_at,
                ],
                [ExperimentRecord.name, ExperimentRecord.quantity_kind, ExperimentRecord.dtype],
                RecordedData.user_id == self.user_id,
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
        return value

    async def _recorded_row(self, resource_id: int, *, include_data: bool) -> Any:
        columns = [
            RecordedData.id,
            RecordedData.measurement_id,
            ExperimentRecord.name,
            ExperimentRecord.quantity_kind,
            ExperimentRecord.tensor_order,
            ExperimentRecord.dtype,
            ExperimentRecord.data_schema,
            RecordedData.file_size,
            RecordedData.updated_at,
        ]
        if include_data:
            columns.append(RecordedData.data)
        row = (
            await self.db.execute(
                select(*columns)
                .join(
                    ExperimentRecord,
                    ExperimentRecord.id == RecordedData.experiment_record_id,
                )
                .where(
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
    shape = data["shape"]
    storage = data["storage"]
    total = math.prod(shape) if shape else 1
    selected_count = min(count, total - offset)
    if storage.get("kind") == "inline":
        return _slice_inline(storage.get("value"), shape, total, offset, count)
    format_code = _DTYPE_FORMATS[dtype]
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
    decoded = base64.b64decode(encoded[character_start:character_end])
    local_start = byte_start - (character_start // 4) * 3
    selected = decoded[local_start : local_start + count * item_size]
    return list(struct.unpack(f"<{count}{format_code}", selected))


def _slice_inline(
    value: Any,
    shape: list[int],
    total: int,
    offset: int,
    count: int,
) -> dict[str, Any]:
    selected_count = min(count, total - offset)
    selected = list(islice(_flatten_inline(value), offset, offset + selected_count))
    next_offset = offset + len(selected)
    return {
        "shape": shape,
        "totalValues": total,
        "offset": offset,
        "values": selected,
        "nextOffset": next_offset if next_offset < total else None,
    }


def _flatten_inline(value: Any) -> Iterable[Any]:
    if isinstance(value, list):
        for item in value:
            yield from _flatten_inline(item)
    else:
        yield value


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
    return value


def _provenance(
    resource: str,
    resource_id: int,
    label: str,
) -> dict[str, Any]:
    return {
        "kind": "database",
        "label": label,
        "resourceType": resource,
        "resourceId": resource_id,
    }


def _text_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
