from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Generic, List, Optional, TypeVar

from fastapi import HTTPException, status
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from utils.datetime_utils import parse_api_datetime_to_utc


ModelT = TypeVar("ModelT")
SchemaT = TypeVar("SchemaT", bound=BaseModel)
ComputedFieldSpec = tuple[tuple[str, ...], str, bool]
ComputedFieldConfig = tuple[ComputedFieldSpec, ...]


@dataclass(frozen=True)
class CrudSpec(Generic[ModelT, SchemaT]):
    model: type[ModelT]
    schema: type[SchemaT]
    scope_path: tuple[str, ...] = field(default_factory=tuple)
    tree_parent_field: str | None = None
    relation_aliases: Mapping[str, str] = field(default_factory=dict)
    computed_fields: Mapping[str, ComputedFieldConfig] = field(default_factory=dict)
    search_aliases: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    count_sort_fields: Mapping[str, str] = field(default_factory=dict)
    read_only_fields: tuple[str, ...] = ("created_at", "updated_at")
    preserve_unset_fields: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class RelationValueSpec:
    field_name: str
    path: tuple[str, ...]
    attr_name: str
    exclude_self: bool = False


def computed(*path: str, attr: str = "id", exclude_self: bool = False) -> ComputedFieldConfig:
    return ((tuple(path), attr, exclude_self),)


def normalize_int_ids(values: Optional[Iterable[Any]], *, sort: bool = False) -> List[int]:
    normalized_ids: List[int] = []
    seen_ids: set[int] = set()

    for value in values or []:
        if not isinstance(value, int) or isinstance(value, bool) or value in seen_ids:
            continue
        seen_ids.add(value)
        normalized_ids.append(value)

    return sorted(normalized_ids) if sort else normalized_ids


def is_admin_user(user: Any | None) -> bool:
    return bool(
        user
        and any(getattr(role, "value", role) == "admin" for role in (user.roles or []))
    )


def get_model_column_python_type(model: type[Any], field_name: str) -> Any | None:
    column = model.__table__.columns.get(field_name)
    if column is None:
        return None

    try:
        return column.type.python_type
    except (AttributeError, NotImplementedError):
        return None


def normalize_payload_value(model: type[Any], field_name: str, value: Any) -> Any:
    if value is None:
        return None
    if get_model_column_python_type(model, field_name) is datetime:
        return parse_api_datetime_to_utc(value)
    return value


def get_relationship_attr(model: type[Any], attr_name: str) -> Any | None:
    relationship_attr = getattr(model, attr_name, None)
    if relationship_attr is None:
        return None

    relationship_property = getattr(relationship_attr, "property", None)
    if relationship_property is None or not hasattr(relationship_property, "mapper"):
        return None

    return relationship_attr


def get_relation_attr_name(spec: CrudSpec[Any, Any], field_name: str) -> str | None:
    if field_name in spec.computed_fields:
        return None

    attr_name = spec.relation_aliases.get(field_name, field_name)
    if get_relationship_attr(spec.model, attr_name) is None:
        return None

    return attr_name


def get_relation_fields(spec: CrudSpec[Any, Any]) -> list[tuple[str, str, type[Any]]]:
    relation_fields: list[tuple[str, str, type[Any]]] = []
    for field_name in spec.schema.model_fields:
        attr_name = get_relation_attr_name(spec, field_name)
        if attr_name is None:
            continue

        relationship_attr = get_relationship_attr(spec.model, attr_name)
        if relationship_attr is None or not relationship_attr.property.uselist:
            continue

        relation_fields.append((field_name, attr_name, relationship_attr.property.mapper.class_))

    return relation_fields


def build_load_options(
    model: type[Any],
    paths: Iterable[tuple[str, ...]],
) -> tuple[Any, ...]:
    unique_paths = {path for path in paths if path}
    compressed_paths = sorted(
        (
            path
            for path in unique_paths
            if not any(
                len(other_path) > len(path) and other_path[: len(path)] == path
                for other_path in unique_paths
            )
        ),
        key=lambda path: (len(path), path),
    )

    load_options = []
    for path in compressed_paths:
        current_model = model
        current_load = None
        for attr_name in path:
            relationship_attr = getattr(current_model, attr_name)
            current_load = (
                selectinload(relationship_attr)
                if current_load is None
                else current_load.selectinload(relationship_attr)
            )
            current_model = relationship_attr.property.mapper.class_
        if current_load is not None:
            load_options.append(current_load)

    return tuple(load_options)


def _scope_parts(spec: CrudSpec[Any, Any]) -> tuple[list[Any], type[Any], Any]:
    relationships: list[Any] = []
    current_model = spec.model
    for attr_name in spec.scope_path:
        relationship_attr = get_relationship_attr(current_model, attr_name)
        if relationship_attr is None or relationship_attr.property.uselist:
            raise RuntimeError(f"Invalid CRUD scope path: {'.'.join(spec.scope_path)}")
        relationships.append(relationship_attr)
        current_model = relationship_attr.property.mapper.class_

    owner_column = current_model.__table__.columns.get("user_id")
    if owner_column is None:
        raise RuntimeError(f"CRUD model {spec.model.__name__} has no ownership scope.")
    return relationships, current_model, owner_column


def build_scope_clause(
    spec: CrudSpec[Any, Any],
    user: Any | None,
    *,
    write: bool,
    read_scope: str = "visible",
) -> Any | None:
    relationships, owner_model, owner_column = _scope_parts(spec)
    demo_clause = None
    if getattr(owner_model, "__tablename__", None) == "experiments":
        from db import ExperimentDemo

        demo_clause = owner_model.id.in_(select(ExperimentDemo.experiment_id))
    if write:
        if is_admin_user(user):
            return None
        if user is None:
            return owner_column.is_not(None) & owner_column.is_(None)
        clause = owner_column == user.id
    else:
        if read_scope == "mine":
            if user is None:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required for mine scope.")
            clause = owner_column == user.id
        elif read_scope == "public":
            clause = demo_clause if demo_clause is not None else owner_column.is_(None)
        elif is_admin_user(user):
            return None
        elif user is None:
            clause = demo_clause if demo_clause is not None else owner_column.is_(None)
        else:
            clause = (
                or_(owner_column == user.id, demo_clause)
                if demo_clause is not None
                else or_(owner_column.is_(None), owner_column == user.id)
            )

    for relationship_attr in reversed(relationships):
        clause = relationship_attr.has(clause)
    return clause


async def get_scope_owner_ids(
    db: AsyncSession,
    spec: CrudSpec[Any, Any],
    ids: Iterable[int],
) -> dict[int, str | None]:
    normalized_ids = normalize_int_ids(ids, sort=True)
    if not normalized_ids:
        return {}

    relationships, _, owner_column = _scope_parts(spec)
    stmt = select(spec.model.id, owner_column.label("owner_id")).select_from(spec.model)
    for relationship_attr in relationships:
        stmt = stmt.join(relationship_attr)
    stmt = stmt.where(spec.model.id.in_(normalized_ids))
    return {row.id: row.owner_id for row in (await db.execute(stmt)).all()}
