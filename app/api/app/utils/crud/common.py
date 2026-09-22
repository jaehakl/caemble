from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any, Generic, List, Optional, TypeVar

from fastapi import HTTPException, status
from pydantic import BaseModel
from sqlalchemy import or_, select


ModelT = TypeVar("ModelT")
SchemaT = TypeVar("SchemaT", bound=BaseModel)


@dataclass(frozen=True)
class CrudSpec(Generic[ModelT, SchemaT]):
    model: type[ModelT]
    schema: type[SchemaT]
    scope_path: tuple[str, ...] = field(default_factory=tuple)
    relation_aliases: Mapping[str, str] = field(default_factory=dict)
    search_aliases: Mapping[str, tuple[str, ...]] = field(default_factory=dict)


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


def get_relationship_attr(model: type[Any], attr_name: str) -> Any | None:
    relationship_attr = getattr(model, attr_name, None)
    if relationship_attr is None:
        return None

    relationship_property = getattr(relationship_attr, "property", None)
    if relationship_property is None or not hasattr(relationship_property, "mapper"):
        return None

    return relationship_attr


def get_relation_fields(spec: CrudSpec[Any, Any]) -> list[tuple[str, str, type[Any]]]:
    relation_fields: list[tuple[str, str, type[Any]]] = []
    for field_name in spec.schema.model_fields:
        attr_name = spec.relation_aliases.get(field_name, field_name)
        relationship_attr = get_relationship_attr(spec.model, attr_name)
        if relationship_attr is None or not relationship_attr.property.uselist:
            continue

        relation_fields.append((field_name, attr_name, relationship_attr.property.mapper.class_))

    return relation_fields


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
