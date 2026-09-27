import hashlib

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from db import CalculationSource


async def get_or_create_calculation_source(db: AsyncSession, code: str) -> CalculationSource:
    """Do not commit here: the definition and its Experiment binding are atomic."""
    digest = hashlib.sha256(code.encode("utf-8")).hexdigest()
    await db.execute(insert(CalculationSource).values(source_code=code, source_hash=digest)
                     .on_conflict_do_nothing(index_elements=[CalculationSource.source_hash]))
    source = await db.scalar(select(CalculationSource).where(CalculationSource.source_hash == digest))
    if source is None or source.source_code != code:
        raise HTTPException(409, "Calculation source hash collision; source was not linked.")
    return source
