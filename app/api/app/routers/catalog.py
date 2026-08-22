from __future__ import annotations

import base64
import binascii
from typing import Annotated, Any

from caemble_catalog import Catalog, CatalogAmbiguousError, CatalogNotFoundError
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from catalog_models import (
    CatalogMeta,
    CatalogPage,
    CatalogRuntimeSlice,
    CatalogRuntimeSliceRequest,
    CatalogSearchResponse,
    ExperimentDetail,
    ExperimentSummary,
    MaterialModel,
    MaterialParameter,
    MaterialParameterDetail,
    QuantityKind,
    QuantityKindDetail,
    SolverDetail,
    SolverSummary,
)

router = APIRouter(prefix="/catalog", tags=["catalog"])


def get_catalog(request: Request) -> Catalog:
    catalog = getattr(request.app.state, "catalog", None)
    if not isinstance(catalog, Catalog):
        raise HTTPException(status_code=503, detail={"code": "catalog_unavailable", "message": "Catalog is unavailable."})
    return catalog


def _offset(cursor: str | None) -> int:
    if cursor is None:
        return 0
    try:
        value = base64.urlsafe_b64decode(cursor.encode("ascii") + b"===").decode("ascii")
        offset = int(value)
    except (UnicodeError, ValueError, binascii.Error) as error:
        raise HTTPException(status_code=422, detail={"code": "invalid_cursor", "message": "Invalid cursor."}) from error
    if offset < 0:
        raise HTTPException(status_code=422, detail={"code": "invalid_cursor", "message": "Invalid cursor."})
    return offset


def _cursor(offset: int, count: int, total: int) -> str | None:
    next_offset = offset + count
    if next_offset >= total:
        return None
    return base64.urlsafe_b64encode(str(next_offset).encode("ascii")).decode("ascii").rstrip("=")


def _cache(response: Response, catalog: Catalog) -> None:
    revision = catalog.meta()["catalogRevision"]
    response.headers["ETag"] = f'"{revision}"'
    response.headers["Cache-Control"] = "public, max-age=300, stale-while-revalidate=3600"


def _not_found(error: CatalogNotFoundError) -> HTTPException:
    return HTTPException(status_code=404, detail={"code": "catalog_not_found", "message": str(error)})


def _ambiguous(error: CatalogAmbiguousError) -> HTTPException:
    return HTTPException(status_code=409, detail={"code": "catalog_ambiguous", "message": str(error)})


@router.get("/meta", response_model=CatalogMeta)
def meta(response: Response, catalog: Catalog = Depends(get_catalog)):
    _cache(response, catalog)
    return catalog.meta()


@router.get("/quantity-kinds", response_model=CatalogPage[QuantityKind])
def quantity_kinds(
    response: Response,
    q: str | None = Query(default=None, max_length=200),
    domain: str | None = Query(default=None, max_length=100),
    solver_name: str | None = Query(default=None, alias="solverName", max_length=200),
    solver_version: str | None = Query(default=None, alias="solverVersion", max_length=100),
    usage: str | None = Query(default=None, pattern="^(parameter|material|input|output|axis)$"),
    unit: str | None = Query(default=None, max_length=200),
    tensor_order: int | None = Query(default=None, alias="tensorOrder", ge=0, le=16),
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None, max_length=100),
    catalog: Catalog = Depends(get_catalog),
):
    offset = _offset(cursor)
    items, total = catalog.list_quantity_kinds(
        query=q,
        domain=domain,
        solver_name=solver_name,
        solver_version=solver_version,
        usage=usage,
        unit=unit,
        tensor_order=tensor_order,
        limit=limit,
        offset=offset,
    )
    _cache(response, catalog)
    return {"items": items, "nextCursor": _cursor(offset, len(items), total), "total": total}


@router.get("/quantity-kinds/{name:path}", response_model=QuantityKindDetail)
def quantity_kind(name: str, response: Response, catalog: Catalog = Depends(get_catalog)):
    try:
        result = {**catalog.quantity_kind(name), **catalog.quantity_kind_relations(name)}
    except CatalogNotFoundError as error:
        raise _not_found(error) from error
    _cache(response, catalog)
    return result


@router.get("/material-parameters", response_model=CatalogPage[MaterialParameter])
def material_parameters(
    response: Response,
    q: str | None = Query(default=None, max_length=200),
    domain: str | None = Query(default=None, max_length=100),
    quantity_kind: str | None = Query(default=None, alias="quantityKind", max_length=200),
    solver_name: str | None = Query(default=None, alias="solverName", max_length=200),
    solver_version: str | None = Query(default=None, alias="solverVersion", max_length=100),
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None, max_length=100),
    catalog: Catalog = Depends(get_catalog),
):
    offset = _offset(cursor)
    items, total = catalog.list_material_parameters(
        query=q,
        domain=domain,
        solver_name=solver_name,
        solver_version=solver_version,
        quantity_kind=quantity_kind,
        limit=limit,
        offset=offset,
    )
    _cache(response, catalog)
    return {"items": items, "nextCursor": _cursor(offset, len(items), total), "total": total}


@router.get("/material-parameters/{key:path}", response_model=MaterialParameterDetail)
def material_parameter(key: str, response: Response, catalog: Catalog = Depends(get_catalog)):
    try:
        result = {**catalog.material_parameter(key), **catalog.material_parameter_relations(key)}
    except CatalogNotFoundError as error:
        raise _not_found(error) from error
    _cache(response, catalog)
    return result


@router.get("/material-models", response_model=CatalogPage[MaterialModel])
def material_models(
    response: Response,
    q: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None, max_length=100),
    catalog: Catalog = Depends(get_catalog),
):
    offset = _offset(cursor)
    items, total = catalog.list_material_models(query=q, limit=limit, offset=offset)
    _cache(response, catalog)
    return {"items": items, "nextCursor": _cursor(offset, len(items), total), "total": total}


@router.get("/material-models/{key:path}", response_model=MaterialModel)
def material_model(key: str, response: Response, catalog: Catalog = Depends(get_catalog)):
    try:
        result = catalog.material_model(key)
    except CatalogNotFoundError as error:
        raise _not_found(error) from error
    _cache(response, catalog)
    return result


@router.get("/solvers", response_model=CatalogPage[SolverSummary])
def solvers(
    response: Response,
    q: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None, max_length=100),
    catalog: Catalog = Depends(get_catalog),
):
    offset = _offset(cursor)
    items, total = catalog.page_solvers(query=q, limit=limit, offset=offset)
    _cache(response, catalog)
    return {"items": items, "nextCursor": _cursor(offset, len(items), total), "total": total}


@router.get("/solvers/{name}/{version}", response_model=SolverDetail)
def solver(name: str, version: str, response: Response, catalog: Catalog = Depends(get_catalog)):
    try:
        result = catalog.solver_detail(name, version)
    except CatalogNotFoundError as error:
        raise _not_found(error) from error
    _cache(response, catalog)
    return result


@router.get("/experiments", response_model=CatalogPage[ExperimentSummary])
def experiments(
    response: Response,
    q: str | None = Query(default=None, max_length=200),
    solver_name: str | None = Query(default=None, alias="solverName", max_length=200),
    solver_version: str | None = Query(default=None, alias="solverVersion", max_length=100),
    namespace: str | None = Query(default=None, max_length=32),
    repository: str | None = Query(default=None, max_length=64),
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None, max_length=100),
    catalog: Catalog = Depends(get_catalog),
):
    offset = _offset(cursor)
    items, total = catalog.list_experiments(
        query=q,
        solver_name=solver_name,
        solver_version=solver_version,
        namespace=namespace,
        repository=repository,
        limit=limit,
        offset=offset,
    )
    _cache(response, catalog)
    return {"items": items, "nextCursor": _cursor(offset, len(items), total), "total": total}


@router.get("/experiments/{key}", response_model=ExperimentDetail)
def experiment(
    key: str,
    response: Response,
    namespace: str | None = Query(default=None, max_length=32),
    repository: str | None = Query(default=None, max_length=64),
    version: str | None = Query(
        default=None,
        pattern=r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$",
        max_length=32,
    ),
    catalog: Catalog = Depends(get_catalog),
):
    try:
        result = catalog.experiment(key, namespace=namespace, repository=repository, version=version)
    except CatalogNotFoundError as error:
        raise _not_found(error) from error
    except CatalogAmbiguousError as error:
        raise _ambiguous(error) from error
    _cache(response, catalog)
    return result


@router.get("/search", response_model=CatalogSearchResponse)
def search(
    response: Response,
    q: Annotated[str, Query(min_length=1, max_length=200)],
    limit: int = Query(default=30, ge=1, le=100),
    catalog: Catalog = Depends(get_catalog),
):
    _cache(response, catalog)
    return {"items": catalog.search(q, limit=limit)}


@router.post("/runtime-slice", response_model=CatalogRuntimeSlice)
def runtime_slice(request: CatalogRuntimeSliceRequest, response: Response, catalog: Catalog = Depends(get_catalog)):
    try:
        result = catalog.runtime_slice(
            solvers=[(item.name, item.version) for item in request.solvers],
            quantity_kinds=request.quantityKinds,
            material_parameters=request.materialParameters,
            material_models=request.materialModels,
        )
    except CatalogNotFoundError as error:
        raise _not_found(error) from error
    _cache(response, catalog)
    return result
