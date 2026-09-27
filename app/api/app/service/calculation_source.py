import hashlib

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from db import CalculationSource
from calculation_contract import extract_contract, contract_hash


async def get_or_create_calculation_source(db: AsyncSession, code: str, *, name: str = "Calculation", description: str | None = None, owner_id: str | None = None) -> CalculationSource:
    """Do not commit here: the definition and its Experiment binding are atomic."""
    digest = hashlib.sha256(code.encode("utf-8")).hexdigest()
    existing = await db.scalar(select(CalculationSource).where(CalculationSource.source_hash == digest))
    if existing is not None:
        if existing.source_code != code:
            raise HTTPException(409, "Calculation source hash collision.")
        return existing
    try:
        contract = extract_contract(code)
        if contract is None:
            raise ValueError("New Calculation definitions require a leading @caemble-contract declaration.")
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    await db.execute(insert(CalculationSource).values(source_code=code, source_hash=digest,
                     name=name, description=description, owner_id=owner_id, revision=1,
                     input_contract=contract["inputs"], output_contract=contract["output"], contract_hash=contract_hash(contract))
                     .on_conflict_do_nothing(index_elements=[CalculationSource.source_hash]))
    source = await db.scalar(select(CalculationSource).where(CalculationSource.source_hash == digest))
    if source is None or source.source_code != code:
        raise HTTPException(409, "Calculation source hash collision; source was not linked.")
    return source
