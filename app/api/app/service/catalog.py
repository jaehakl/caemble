from __future__ import annotations

import base64
from typing import Any

from caemble_catalog import Catalog

from catalog_models import CatalogRuntimeSliceRequest


def _offset(cursor: str | None) -> int:
    if cursor is None:
        return 0
    value = base64.urlsafe_b64decode(cursor.encode("ascii") + b"===").decode("ascii")
    return int(value)


def _cursor(offset: int, count: int, total: int) -> str | None:
    next_offset = offset + count
    if next_offset >= total:
        return None
    return (
        base64.urlsafe_b64encode(str(next_offset).encode("ascii"))
        .decode("ascii")
        .rstrip("=")
    )


def _revision(catalog: Catalog) -> str:
    return catalog.meta()["catalogRevision"]


def _page(
    catalog: Catalog,
    items: list[Any],
    total: int,
    offset: int,
) -> tuple[dict[str, Any], str]:
    return (
        {
            "items": items,
            "nextCursor": _cursor(offset, len(items), total),
            "total": total,
        },
        _revision(catalog),
    )


def catalog_meta(catalog: Catalog) -> tuple[dict[str, Any], str]:
    result = catalog.meta()
    return result, result["catalogRevision"]


def list_quantity_kinds(
    catalog: Catalog,
    *,
    query: str | None,
    domain: str | None,
    solver_name: str | None,
    solver_version: str | None,
    usage: str | None,
    unit: str | None,
    tensor_order: int | None,
    limit: int,
    cursor: str | None,
) -> tuple[dict[str, Any], str]:
    offset = _offset(cursor)
    items, total = catalog.list_quantity_kinds(
        query=query,
        domain=domain,
        solver_name=solver_name,
        solver_version=solver_version,
        usage=usage,
        unit=unit,
        tensor_order=tensor_order,
        limit=limit,
        offset=offset,
    )
    return _page(catalog, items, total, offset)


def get_quantity_kind(catalog: Catalog, name: str) -> tuple[dict[str, Any], str]:
    result = {**catalog.quantity_kind(name), **catalog.quantity_kind_relations(name)}
    return result, _revision(catalog)


def list_material_parameters(
    catalog: Catalog,
    *,
    query: str | None,
    domain: str | None,
    quantity_kind: str | None,
    solver_name: str | None,
    solver_version: str | None,
    limit: int,
    cursor: str | None,
) -> tuple[dict[str, Any], str]:
    offset = _offset(cursor)
    items, total = catalog.list_material_parameters(
        query=query,
        domain=domain,
        solver_name=solver_name,
        solver_version=solver_version,
        quantity_kind=quantity_kind,
        limit=limit,
        offset=offset,
    )
    return _page(catalog, items, total, offset)


def get_material_parameter(catalog: Catalog, key: str) -> tuple[dict[str, Any], str]:
    result = {
        **catalog.material_parameter(key),
        **catalog.material_parameter_relations(key),
    }
    return result, _revision(catalog)


def list_material_models(
    catalog: Catalog,
    *,
    query: str | None,
    limit: int,
    cursor: str | None,
) -> tuple[dict[str, Any], str]:
    offset = _offset(cursor)
    items, total = catalog.list_material_models(
        query=query,
        limit=limit,
        offset=offset,
    )
    return _page(catalog, items, total, offset)


def get_material_model(catalog: Catalog, key: str) -> tuple[dict[str, Any], str]:
    return catalog.material_model(key), _revision(catalog)


def list_solvers(
    catalog: Catalog,
    *,
    query: str | None,
    limit: int,
    cursor: str | None,
) -> tuple[dict[str, Any], str]:
    offset = _offset(cursor)
    items, total = catalog.page_solvers(query=query, limit=limit, offset=offset)
    return _page(catalog, items, total, offset)


def get_solver(
    catalog: Catalog,
    name: str,
    version: str,
) -> tuple[dict[str, Any], str]:
    return catalog.solver_detail(name, version), _revision(catalog)


def list_experiments(
    catalog: Catalog,
    *,
    query: str | None,
    solver_name: str | None,
    solver_version: str | None,
    namespace: str | None,
    repository: str | None,
    limit: int,
    cursor: str | None,
) -> tuple[dict[str, Any], str]:
    offset = _offset(cursor)
    items, total = catalog.list_experiments(
        query=query,
        solver_name=solver_name,
        solver_version=solver_version,
        namespace=namespace,
        repository=repository,
        limit=limit,
        offset=offset,
    )
    return _page(catalog, items, total, offset)


def get_experiment(
    catalog: Catalog,
    key: str,
    *,
    namespace: str | None,
    repository: str | None,
    version: str | None,
) -> tuple[dict[str, Any], str]:
    result = catalog.experiment(
        key,
        namespace=namespace,
        repository=repository,
        version=version,
    )
    return result, _revision(catalog)


def search_catalog(
    catalog: Catalog,
    query: str,
    *,
    limit: int,
) -> tuple[dict[str, Any], str]:
    return {"items": catalog.search(query, limit=limit)}, _revision(catalog)


def build_runtime_slice(
    catalog: Catalog,
    request: CatalogRuntimeSliceRequest,
) -> tuple[dict[str, Any], str]:
    result = catalog.runtime_slice(
        solvers=[(item.name, item.version) for item in request.solvers],
        quantity_kinds=request.quantityKinds,
        material_parameters=request.materialParameters,
        material_models=request.materialModels,
    )
    return result, _revision(catalog)
