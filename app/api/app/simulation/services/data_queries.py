"""Visible Experiment, Measurement and RecordedData queries."""
from __future__ import annotations

import math
from typing import Any

from sqlalchemy import Text, cast, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.data_tools import VisibleDataError, json_mapping, json_value, provenance, search_pattern, slice_recorded_tensor
from simulation.db import Experiment, ExperimentRecord, Measurement, RecordedData
from simulation.services.access import source_visibility


class SimulationDataReader:
    def __init__(self, db: AsyncSession, user_id: str):
        self.db = db
        self.user_id = user_id

    async def search(
        self,
        resource: str,
        query: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        pattern = search_pattern(query)
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
        return [json_mapping(row) for row in (await self.db.execute(statement)).mappings().all()]

    async def detail(self, resource: str, resource_id: int) -> dict[str, Any]:
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
                "updatedAt": json_value(row["updated_at"]),
            }
        if resource == "measurement":
            row = await self._one_visible(
                select(
                    Measurement.id,
                    Measurement.experiment_id,
                    Measurement.vars,
                    Measurement.material_snapshot,
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
                **json_mapping(row),
                "vars": row["vars"],
                "material_snapshot": row["material_snapshot"],
                "recordedData": [json_mapping(item) for item in recorded_rows],
                "resultContracts": (await self.db.get(Experiment, row["experiment_id"])).result_contracts,
            }
        if resource == "recorded_data":
            row = await self._recorded_row(resource_id, include_data=False)
            return json_mapping(row)
        raise VisibleDataError("Visible data resource is not supported")

    async def read_source(
        self,
        resource: str,
        resource_id: int,
        path: str | None,
        offset: int,
        length: int,
    ) -> dict[str, Any]:
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
            "provenance": provenance(resource, resource_id, label),
        }

    async def read_recorded_slice(self, resource_id: int, offset: int, count: int) -> dict[str, Any]:
        row = await self._recorded_row(resource_id, include_data=True)
        if row["data"] is None:
            raise VisibleDataError("RecordedData payload is not stored inline")
        from storage.service import object_refs
        if list(object_refs(row["data"])):
            total = math.prod(row["data"]["shape"]) if row["data"]["shape"] else 1
            if offset < 0 or offset > total or count < 1 or count > 10000:
                raise VisibleDataError("Slice offset or count is outside the available tensor.")
            return {"id": row["id"], "name": row["name"], "dtype": row["dtype"],
                    "schema": row["data_schema"] or {"dtype": row["dtype"]},
                    "quantityKind": row["quantity_kind"], "downloadRequired": True,
                    "data": row["data"], "offset": offset, "count": count}
        result = slice_recorded_tensor(row["data"], row["dtype"], offset, count)
        return {
            "id": row["id"],
            "name": row["name"],
            "quantityKind": row["quantity_kind"],
            "dtype": row["dtype"],
            "dataSchema": row["data_schema"],
            **result,
            **{key: row["data"][key] for key in ("axes", "boxGrid", "metadata") if key in row["data"]},
            **({"resultProvenance": row["data"]["provenance"]} if "provenance" in row["data"] else {}),
            "provenance": provenance(
                "recorded_data",
                row["id"],
                row["name"],
            ),
        }

    def _simple_search_spec(self, resource: str) -> tuple[Any, list[Any], list[Any], Any]:
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
                source_visibility(Experiment.user_id, self.user_id),
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
        visibility = model.user_id == self.user_id if own_only else source_visibility(model.user_id, self.user_id)
        row = (
            await self.db.execute(statement.where(model.id == resource_id, visibility))
        ).mappings().one_or_none()
        if row is None:
            raise VisibleDataError("Visible data was not found")
        return row

