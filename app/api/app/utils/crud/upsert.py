from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import inspect, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from models import UpsertResponseBase
from utils.crud.common import (
    CrudSpec,
    get_scope_owner_ids,
    is_admin_user,
    normalize_payload_value,
)


async def _fetch_entities_by_ids(
    db: AsyncSession,
    model: type[Any],
    ids: Iterable[Any],
) -> dict[Any, Any]:
    normalized_ids = {entity_id for entity_id in ids if entity_id is not None}
    if not normalized_ids:
        return {}
    result = await db.execute(select(model).where(model.id.in_(normalized_ids)))
    return {entity.id: entity for entity in result.scalars().all()}


def _scalar_fk_relationships(model: type[Any]) -> dict[str, type[Any]]:
    relationships: dict[str, type[Any]] = {}
    for relationship in inspect(model).relationships:
        if relationship.uselist or len(relationship.local_columns) != 1:
            continue
        local_column = next(iter(relationship.local_columns))
        if not local_column.foreign_keys:
            continue
        relationships[local_column.name] = relationship.mapper.class_
    return relationships


def _constraint_detail(error: IntegrityError) -> str:
    constraint_name = getattr(getattr(error, "orig", None), "diag", None)
    constraint_name = getattr(constraint_name, "constraint_name", "")
    if constraint_name in {
        "uq_material_names_public_name",
        "uq_material_names_user_name",
    }:
        return "Material name already exists in this visibility scope."
    return "Database constraint violation."


async def _validate_tree_cycles(
    db: AsyncSession,
    spec: CrudSpec[Any, Any],
    items: list[Any],
) -> None:
    parent_field = spec.tree_parent_field
    if parent_field is None:
        return

    proposed_parents = {
        item.id: getattr(item, parent_field)
        for item in items
        if item.id is not None
    }
    stored_parents: dict[int, int | None] = {}

    async def get_parent(entity_id: int) -> int | None:
        if entity_id in proposed_parents:
            return proposed_parents[entity_id]
        if entity_id not in stored_parents:
            stored_parents[entity_id] = await db.scalar(
                select(getattr(spec.model, parent_field)).where(spec.model.id == entity_id)
            )
        return stored_parents[entity_id]

    for item in items:
        if item.id is None:
            continue
        seen = {item.id}
        parent_id = getattr(item, parent_field)
        while parent_id is not None:
            if parent_id in seen:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"{spec.model.__name__} parent relationship cannot contain a cycle.",
                )
            seen.add(parent_id)
            parent_id = await get_parent(parent_id)


async def upsert_items(
    db: AsyncSession,
    items: list[Any],
    spec: CrudSpec[Any, Any],
    *,
    user: Any | None,
) -> list[UpsertResponseBase]:
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")
    if not items:
        return []

    supplied_ids = [item.id for item in items if item.id is not None]
    if len(supplied_ids) != len(set(supplied_ids)):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Duplicate upsert ids.")

    existing_entities = await _fetch_entities_by_ids(db, spec.model, supplied_ids)
    missing_ids = sorted(set(supplied_ids) - set(existing_entities))
    if missing_ids:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Items not found: {missing_ids}.")

    existing_owner_ids = await get_scope_owner_ids(db, spec, supplied_ids)
    admin = is_admin_user(user)
    if not admin:
        inaccessible_ids = sorted(
            entity_id
            for entity_id in supplied_ids
            if existing_owner_ids.get(entity_id) != user.id
        )
        if inaccessible_ids:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Items not found: {inaccessible_ids}.")

    for item in items:
        existing = existing_entities.get(item.id)
        if existing is None:
            continue
        changed_field = next(
            (
                field_name
                for field_name in spec.immutable_update_fields
                if getattr(existing, field_name) != getattr(item, field_name)
            ),
            None,
        )
        if changed_field is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"{spec.model.__name__}.{changed_field} cannot be changed through generic upsert; "
                    "use the dedicated save endpoint."
                ),
            )

    direct_owner = spec.model.__table__.columns.get("user_id") is not None
    effective_owners: list[str | None] = []
    for item in items:
        existing = existing_entities.get(item.id)
        if direct_owner:
            if not admin:
                owner_id = user.id
            elif "user_id" in item.model_fields_set:
                owner_id = item.user_id
            elif existing is not None:
                owner_id = existing.user_id
            else:
                owner_id = user.id
            effective_owners.append(owner_id)
        else:
            effective_owners.append(None)

    proposed_owner_ids = {
        item.id: effective_owners[index]
        for index, item in enumerate(items)
        if direct_owner and item.id is not None
    }

    fk_relationships = _scalar_fk_relationships(spec.model)
    requested_fk_ids: dict[type[Any], set[Any]] = defaultdict(set)
    for index, item in enumerate(items):
        for field_name, target_model in fk_relationships.items():
            value = (
                effective_owners[index]
                if direct_owner and field_name == "user_id"
                else getattr(item, field_name, None)
            )
            if value is not None:
                requested_fk_ids[target_model].add(value)

    targets_by_model: dict[type[Any], dict[Any, Any]] = {}
    for target_model, ids in requested_fk_ids.items():
        targets_by_model[target_model] = await _fetch_entities_by_ids(db, target_model, ids)

    for index, item in enumerate(items):
        if not direct_owner:
            scope_field = next(iter(fk_relationships))
            scope_target = targets_by_model.get(fk_relationships[scope_field], {}).get(
                getattr(item, scope_field)
            )
            if scope_target is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{scope_field} not found.")
            effective_owners[index] = scope_target.user_id
            if not admin and scope_target.user_id != user.id:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{scope_field} not found.")

        owner_id = effective_owners[index]
        for field_name, target_model in fk_relationships.items():
            target_id = (
                owner_id
                if direct_owner and field_name == "user_id"
                else getattr(item, field_name, None)
            )
            if target_id is None:
                continue
            target = targets_by_model.get(target_model, {}).get(target_id)
            if target is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{field_name} not found.")
            if field_name == "user_id" or target_model.__table__.columns.get("user_id") is None:
                continue
            target_owner_id = (
                proposed_owner_ids[target_id]
                if target_model is spec.model and target_id in proposed_owner_ids
                else target.user_id
            )
            if owner_id is None and target_owner_id is not None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{field_name} not found.")
            if owner_id is not None and target_owner_id not in {None, owner_id}:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{field_name} not found.")

    await _validate_tree_cycles(db, spec, items)

    writable_columns = {
        column.name
        for column in spec.model.__table__.columns
        if column.name not in {"id", *spec.read_only_fields}
    }
    pending_entities: list[Any] = []
    for index, item in enumerate(items):
        entity = existing_entities.get(item.id)
        if entity is None:
            entity = spec.model()
            db.add(entity)

        payload = item.model_dump(include=writable_columns)
        for field_name in spec.preserve_unset_fields:
            if field_name not in item.model_fields_set:
                payload.pop(field_name, None)
        if direct_owner:
            payload["user_id"] = effective_owners[index]

        for field_name, value in payload.items():
            setattr(entity, field_name, normalize_payload_value(spec.model, field_name, value))
        pending_entities.append(entity)

    try:
        await db.flush()
        await db.commit()
    except IntegrityError as error:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=_constraint_detail(error),
        ) from error

    return [UpsertResponseBase(id=entity.id) for entity in pending_entities]
