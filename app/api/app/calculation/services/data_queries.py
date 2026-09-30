"""Visible Calculation summaries and source reads."""
from __future__ import annotations

from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from calculation.db import Calculation
from core.data_tools import VisibleDataError, json_mapping, json_value, provenance, search_pattern, text_hash
from simulation.db import Experiment
from simulation.services.access import source_visibility


class CalculationDataReader:
    def __init__(self, db: AsyncSession, user_id: str):
        self.db = db
        self.user_id = user_id

    async def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        pattern = search_pattern(query)
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
                source_visibility(Experiment.user_id, self.user_id),
                or_(
                    Calculation.name.ilike(pattern, escape="\\"),
                    Calculation.description.ilike(pattern, escape="\\"),
                ),
            )
            .order_by(Calculation.updated_at.desc(), Calculation.id.desc())
            .limit(limit)
        )
        return [
            json_mapping(row)
            for row in (await self.db.execute(statement)).mappings().all()
        ]


    async def detail(self, resource_id: int) -> dict[str, Any]:
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
                    source_visibility(Experiment.user_id, self.user_id),
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
            "sourceSha256": text_hash(row["source_code"]),
            "updatedAt": json_value(row["updated_at"]),
        }


    async def read_source(
        self, resource_id: int, path: str | None, offset: int, length: int,
    ) -> dict[str, Any]:
        resource = "calculation"
        row = (
            await self.db.execute(
                select(Calculation.id, Calculation.name, Calculation.source_code)
                .join(Experiment, Experiment.id == Calculation.experiment_id)
                .where(
                    Calculation.id == resource_id,
                    source_visibility(Experiment.user_id, self.user_id),
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
            "sha256": text_hash(source),
            "offset": offset,
            "totalCharacters": len(source),
            "content": content,
            "nextOffset": next_offset if next_offset < len(source) else None,
            "provenance": provenance(resource, resource_id, row["name"]),
        }

