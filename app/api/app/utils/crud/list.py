from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Sequence
from datetime import datetime
from typing import Any, Callable, List

from sqlalchemy import Text, and_, cast, func, inspect, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from utils.datetime_utils import db_datetime_to_utc, parse_api_datetime_to_utc
from utils.crud.common import (
    CrudSpec,
    RelationValueSpec,
    build_scope_clause,
    get_model_column_python_type,
    get_relation_attr_name,
    get_relation_fields,
    get_relationship_attr,
    normalize_int_ids,
)


def _combine_clauses(combinator: Callable[..., Any], clauses: Iterable[Any | None]) -> Any | None:
    filtered_clauses = [clause for clause in clauses if clause is not None]
    if not filtered_clauses:
        return None
    if len(filtered_clauses) == 1:
        return filtered_clauses[0]
    return combinator(*filtered_clauses)


def _build_search_clause(
    spec: CrudSpec[Any, Any],
    column: Any,
    raw_text: Any,
) -> Any | None:
    if not isinstance(raw_text, str):
        return None

    search_text = raw_text.strip()
    if not search_text:
        return None

    python_type = get_model_column_python_type(spec.model, column.name)
    if python_type is str:
        return column.ilike(f"%{search_text}%")
    if python_type is dict:
        return cast(column, Text).ilike(f"%{search_text}%")
    return None


def _is_required_text_column(column: Any) -> bool:
    return isinstance(column.type, Text) and not column.nullable


def _build_text_clause(column: Any, raw_text: Any) -> Any | None:
    if not isinstance(raw_text, str):
        return None

    search_text = raw_text.strip()
    if not search_text:
        return None

    return column.ilike(f"%{search_text}%")


def _get_required_text_columns(model: type[Any]) -> list[Any]:
    return [column for column in model.__table__.columns if _is_required_text_column(column)]


def _build_search_text_clause(
    spec: CrudSpec[Any, Any],
    searchable_columns: Sequence[Any],
    raw_text: Any,
) -> Any | None:
    direct_columns = _get_required_text_columns(spec.model)
    if direct_columns:
        return _combine_clauses(
            or_,
            (_build_text_clause(column, raw_text) for column in direct_columns),
        )

    relation_clauses: list[Any] = []
    for relationship in inspect(spec.model).relationships:
        if relationship.uselist or not any(column.foreign_keys for column in relationship.local_columns):
            continue

        target_columns = _get_required_text_columns(relationship.mapper.class_)
        if not target_columns:
            continue

        relationship_attr = getattr(spec.model, relationship.key, None)
        if relationship_attr is None:
            continue

        target_clause = _combine_clauses(
            or_,
            (_build_text_clause(column, raw_text) for column in target_columns),
        )
        if target_clause is not None:
            relation_clauses.append(relationship_attr.has(target_clause))

    relation_clause = _combine_clauses(or_, relation_clauses)
    if relation_clause is not None:
        return relation_clause

    return _combine_clauses(
        or_,
        (_build_search_clause(spec, column, raw_text) for column in searchable_columns),
    )


def _coerce_filter_bound(value: Any, python_type: type[Any]) -> Any | None:
    if value is None:
        return None

    try:
        if python_type is int:
            return int(value)
        if python_type is float:
            return float(value)
        if python_type is datetime:
            return parse_api_datetime_to_utc(value)
    except (TypeError, ValueError):
        return None

    return None


def _build_where_clause(
    request: Any,
    spec: CrudSpec[Any, Any],
    base_clause: Any | None,
) -> Any | None:
    selected_clause = None
    normalized_selected_ids = normalize_int_ids(request.selected_ids, sort=True)
    if normalized_selected_ids:
        selected_clause = spec.model.id.in_(normalized_selected_ids)

    searchable_columns = [
        column
        for column in spec.model.__table__.columns
        if get_model_column_python_type(spec.model, column.name) in (str, dict)
    ]

    search_conditions: List[Any] = []
    search_text_clause = _build_search_text_clause(spec, searchable_columns, request.search_text)
    if search_text_clause is not None:
        search_conditions.append(search_text_clause)

    for field_name, raw_texts in (request.text_filter or {}).items():
        if field_name in spec.search_aliases:
            search_clause = _combine_clauses(
                or_,
                (
                    _build_search_clause(spec, column, text)
                    for column_name in spec.search_aliases[field_name]
                    for column in [spec.model.__table__.columns.get(column_name)]
                    if column is not None
                    for text in raw_texts or []
                ),
            )
        else:
            column = spec.model.__table__.columns.get(field_name)
            if column is None:
                continue

            search_clause = _combine_clauses(
                or_,
                (_build_search_clause(spec, column, text) for text in raw_texts or []),
            )

        if search_clause is None:
            continue
        search_conditions.append(search_clause)

    filter_conditions: List[Any] = []
    for field_name, bounds in (request.filter or {}).items():
        python_type = get_model_column_python_type(spec.model, field_name)
        if python_type not in (int, float, datetime):
            continue

        column = spec.model.__table__.columns.get(field_name)
        if column is None:
            continue

        values = list(bounds or [])
        min_value = _coerce_filter_bound(values[0], python_type) if len(values) > 0 else None
        max_value = _coerce_filter_bound(values[1], python_type) if len(values) > 1 else None
        filter_clause = _combine_clauses(
            and_,
            (
                column >= min_value if min_value is not None else None,
                column <= max_value if max_value is not None else None,
            ),
        )
        if filter_clause is not None:
            filter_conditions.append(filter_clause)

    for field_name, operation in (getattr(request, "null_filter", None) or {}).items():
        column = spec.model.__table__.columns.get(field_name)
        if column is None:
            continue
        filter_conditions.append(
            column.is_(None) if operation == "is_null" else column.is_not(None)
        )

    scoped_clause = _combine_clauses(and_, [*search_conditions, *filter_conditions])
    where_clause = _combine_clauses(or_, (selected_clause, scoped_clause))
    return _combine_clauses(and_, (base_clause, where_clause))


def _get_sort_request(request: Any) -> tuple[str | None, str]:
    sort_requests = _get_sort_requests(request)
    if not sort_requests:
        return None, "asc"
    return sort_requests[0]


def _get_sort_requests(request: Any) -> list[tuple[str, str]]:
    raw_sort = getattr(request, "sort", None)
    if not raw_sort:
        return []
    entries = raw_sort if isinstance(raw_sort[0], list) else [raw_sort]
    normalized: list[tuple[str, str]] = []
    for entry in entries:
        if not entry or not isinstance(entry[0], str):
            continue
        direction = str(entry[1] if len(entry) > 1 else "asc").lower()
        normalized.append((entry[0], "desc" if direction == "desc" else "asc"))
    return normalized


def get_list_sort_request(request: Any) -> tuple[str | None, str]:
    return _get_sort_request(request)


def build_list_where_clause(
    request: Any,
    spec: CrudSpec[Any, Any],
    base_clause: Any | None = None,
) -> Any | None:
    return _build_where_clause(request, spec, base_clause)


def _build_column_order_by(
    request: Any,
    spec: CrudSpec[Any, Any],
) -> list[Any]:
    is_random = bool(getattr(request, "random", False))
    order_by_clauses = [func.random()] if is_random else [spec.model.id.desc()]
    sort_requests = _get_sort_requests(request)

    if is_random or not sort_requests:
        return order_by_clauses

    order_by_clauses = []
    sorted_id = False
    for field_name, direction in sort_requests:
        column = spec.model.__table__.columns.get(field_name)
        if column is None:
            continue
        order_by_clauses.append(column.desc() if direction == "desc" else column.asc())
        sorted_id = sorted_id or column is spec.model.__table__.columns.get("id")
    if not order_by_clauses:
        return [spec.model.id.desc()]
    if not sorted_id:
        order_by_clauses.append(spec.model.id.desc())

    return order_by_clauses


def _get_count_sort_relationship(
    request: Any,
    spec: CrudSpec[Any, Any],
) -> tuple[Any, str] | None:
    if bool(getattr(request, "random", False)):
        return None

    field_name, direction = _get_sort_request(request)
    if not field_name:
        return None

    relation_attr_name = spec.count_sort_fields.get(field_name)
    if not relation_attr_name:
        return None

    relationship_attr = get_relationship_attr(spec.model, relation_attr_name)
    if relationship_attr is None:
        return None

    return relationship_attr, direction


async def _get_relation_values_by_field(
    db: AsyncSession,
    model: type[Any],
    entity_ids: Sequence[int],
    relation_specs: Iterable[RelationValueSpec],
) -> dict[str, dict[int, list[int]]]:
    relation_specs = list(relation_specs)
    relation_values_by_field: dict[str, dict[int, list[int]]] = {
        relation_spec.field_name: {entity_id: [] for entity_id in entity_ids}
        for relation_spec in relation_specs
    }
    normalized_entity_ids = normalize_int_ids(entity_ids, sort=True)
    if not normalized_entity_ids:
        return relation_values_by_field

    rows_by_path: dict[tuple[tuple[str, ...], str], list[Any]] = {}
    for relation_spec in relation_specs:
        if not relation_spec.path:
            continue

        path_key = (relation_spec.path, relation_spec.attr_name)
        if path_key not in rows_by_path:
            root_alias = aliased(model)
            current_entity = root_alias
            stmt = select(root_alias.id.label("entity_id")).select_from(root_alias)
            for path_attr_name in relation_spec.path:
                relationship_attr = getattr(current_entity, path_attr_name)
                target_alias = aliased(relationship_attr.property.mapper.class_)
                stmt = stmt.join(relationship_attr.of_type(target_alias))
                current_entity = target_alias

            value_attr = getattr(current_entity, relation_spec.attr_name)
            rows_by_path[path_key] = (
                await db.execute(
                    stmt.add_columns(value_attr.label("value"))
                    .where(root_alias.id.in_(normalized_entity_ids))
                    .order_by(root_alias.id.asc(), value_attr.asc())
                )
            ).all()

        values_by_entity_id: dict[int, list[int]] = defaultdict(list)
        for entity_id, value in rows_by_path[path_key]:
            values_by_entity_id[entity_id].append(value)

        for entity_id in normalized_entity_ids:
            values = normalize_int_ids(values_by_entity_id.get(entity_id), sort=True)
            if relation_spec.exclude_self:
                values = [value for value in values if value != entity_id]
            relation_values_by_field[relation_spec.field_name][entity_id] = normalize_int_ids(
                [
                    *relation_values_by_field[relation_spec.field_name][entity_id],
                    *values,
                ],
                sort=True,
            )

    return relation_values_by_field


async def _get_total(
    db: AsyncSession,
    spec: CrudSpec[Any, Any],
    where_clause: Any | None,
) -> int:
    total_ids_stmt = select(spec.model.id)
    if where_clause is not None:
        total_ids_stmt = total_ids_stmt.where(where_clause)

    total_stmt = select(func.count()).select_from(total_ids_stmt.subquery())
    return (await db.execute(total_stmt)).scalar_one()


async def get_list_total(
    db: AsyncSession,
    spec: CrudSpec[Any, Any],
    where_clause: Any | None,
) -> int:
    return await _get_total(db, spec, where_clause)


async def _get_entities(
    db: AsyncSession,
    request: Any,
    spec: CrudSpec[Any, Any],
    where_clause: Any | None,
) -> list[Any]:
    count_sort = _get_count_sort_relationship(request, spec)
    if count_sort is not None:
        relationship_attr, direction = count_sort
        related_model = relationship_attr.property.mapper.class_
        count_expr = func.count(related_model.id).label("_crud_relation_count")
        stmt = (
            select(spec.model.id.label("entity_id"), count_expr)
            .select_from(spec.model)
            .outerjoin(relationship_attr)
            .group_by(spec.model.id)
            .order_by(
                count_expr.desc() if direction == "desc" else count_expr.asc(),
                spec.model.id.desc(),
            )
        )
        if where_clause is not None:
            stmt = stmt.where(where_clause)
        if request.offset:
            stmt = stmt.offset(request.offset)
        if request.limit is not None:
            stmt = stmt.limit(request.limit)

        ordered_ids = [row.entity_id for row in (await db.execute(stmt)).all()]
        if not ordered_ids:
            return []

        entity_rows = (
            await db.execute(select(spec.model).where(spec.model.id.in_(ordered_ids)))
        ).scalars().all()
        entities_by_id = {entity.id: entity for entity in entity_rows}
        return [entities_by_id[entity_id] for entity_id in ordered_ids if entity_id in entities_by_id]

    stmt = select(spec.model)
    if where_clause is not None:
        stmt = stmt.where(where_clause)
    stmt = stmt.order_by(*_build_column_order_by(request, spec))
    if not bool(getattr(request, "random", False)) and request.offset:
        stmt = stmt.offset(request.offset)
    if request.limit is not None:
        stmt = stmt.limit(request.limit)

    return (await db.execute(stmt)).scalars().all()


async def serialize_list_entities(
    db: AsyncSession,
    entities: Sequence[Any],
    spec: CrudSpec[Any, Any],
) -> list[Any]:
    relation_fields = get_relation_fields(spec)
    relation_value_specs = [
        *(
            RelationValueSpec(
                field_name=field_name,
                path=(attr_name,),
                attr_name="id",
            )
            for field_name, attr_name, _ in relation_fields
        ),
        *(
            RelationValueSpec(
                field_name=field_name,
                path=path,
                attr_name=attr_name,
                exclude_self=exclude_self,
            )
            for field_name, computed_specs in spec.computed_fields.items()
            for path, attr_name, exclude_self in computed_specs
        ),
    ]
    relation_values_by_field = await _get_relation_values_by_field(
        db,
        spec.model,
        [getattr(entity, "id", None) for entity in entities],
        relation_value_specs,
    )
    items: list[Any] = []
    for entity in entities:
        item_data: dict[str, Any] = {}
        for field_name in spec.schema.model_fields:
            computed_spec = spec.computed_fields.get(field_name)
            if computed_spec is not None:
                item_data[field_name] = relation_values_by_field.get(field_name, {}).get(entity.id, [])
                continue

            relation_attr_name = get_relation_attr_name(spec, field_name)
            if relation_attr_name is not None:
                item_data[field_name] = relation_values_by_field.get(field_name, {}).get(entity.id, [])
                continue

            if not hasattr(entity, field_name):
                schema_field = spec.schema.model_fields[field_name]
                if not schema_field.is_required():
                    item_data[field_name] = schema_field.get_default(call_default_factory=True)
                    continue

            field_value = getattr(entity, field_name)
            if (
                get_model_column_python_type(spec.model, field_name) is datetime
                and isinstance(field_value, datetime)
            ):
                field_value = db_datetime_to_utc(field_value)
            item_data[field_name] = field_value

        items.append(spec.schema.model_validate(item_data))

    return items


async def get_list_response(
    db: AsyncSession,
    request: Any,
    spec: CrudSpec[Any, Any],
    base_clause: Any | None = None,
    *,
    user: Any | None = None,
) -> dict[str, Any]:
    scope_clause = build_scope_clause(
        spec,
        user,
        write=False,
        read_scope=getattr(request, "scope", "visible"),
    )
    scoped_base_clause = _combine_clauses(and_, (base_clause, scope_clause))
    where_clause = build_list_where_clause(request, spec, scoped_base_clause)
    total = await get_list_total(db, spec, where_clause)
    entities = await _get_entities(db, request, spec, where_clause)
    items = await serialize_list_entities(db, entities, spec)

    return {"total": total, "items": items}
