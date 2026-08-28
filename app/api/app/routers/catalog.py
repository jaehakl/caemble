from __future__ import annotations

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
from service.catalog import (
    build_runtime_slice,
    catalog_meta,
    get_experiment,
    get_material_model,
    get_material_parameter,
    get_quantity_kind,
    get_solver,
    list_experiments,
    list_material_models,
    list_material_parameters,
    list_quantity_kinds,
    list_solvers,
    search_catalog,
)


router = APIRouter(prefix="/catalog", tags=["catalog"])


def get_catalog(request: Request) -> Catalog:
    catalog = getattr(request.app.state, "catalog", None)
    if not isinstance(catalog, Catalog):
        raise HTTPException(
            status_code=503,
            detail={"code": "catalog_unavailable", "message": "Catalog is unavailable."},
        )
    return catalog


def _cache(response: Response, revision: str) -> None:
    response.headers["ETag"] = f'"{revision}"'
    response.headers["Cache-Control"] = (
        "public, max-age=300, stale-while-revalidate=3600"
    )


def _not_found(error: CatalogNotFoundError) -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={"code": "catalog_not_found", "message": str(error)},
    )


def _ambiguous(error: CatalogAmbiguousError) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={"code": "catalog_ambiguous", "message": str(error)},
    )


@router.get("/meta", response_model=CatalogMeta)
def meta(response: Response, catalog: Catalog = Depends(get_catalog)):
    result, revision = catalog_meta(catalog)
    _cache(response, revision)
    return result


@router.get("/quantity-kinds", response_model=CatalogPage[QuantityKind])
def quantity_kinds(
    response: Response,
    q: str | None = Query(default=None),
    domain: str | None = Query(default=None),
    solver_name: str | None = Query(default=None, alias="solverName"),
    solver_version: str | None = Query(default=None, alias="solverVersion"),
    usage: str | None = Query(default=None),
    unit: str | None = Query(default=None),
    tensor_order: int | None = Query(default=None, alias="tensorOrder"),
    limit: int = Query(default=50),
    cursor: str | None = Query(default=None),
    catalog: Catalog = Depends(get_catalog),
):
    result, revision = list_quantity_kinds(
        catalog,
        query=q,
        domain=domain,
        solver_name=solver_name,
        solver_version=solver_version,
        usage=usage,
        unit=unit,
        tensor_order=tensor_order,
        limit=limit,
        cursor=cursor,
    )
    _cache(response, revision)
    return result


@router.get("/quantity-kinds/{name:path}", response_model=QuantityKindDetail)
def quantity_kind(
    name: str,
    response: Response,
    catalog: Catalog = Depends(get_catalog),
):
    try:
        result, revision = get_quantity_kind(catalog, name)
    except CatalogNotFoundError as error:
        raise _not_found(error) from error
    _cache(response, revision)
    return result


@router.get("/material-parameters", response_model=CatalogPage[MaterialParameter])
def material_parameters(
    response: Response,
    q: str | None = Query(default=None),
    domain: str | None = Query(default=None),
    quantity_kind: str | None = Query(default=None, alias="quantityKind"),
    solver_name: str | None = Query(default=None, alias="solverName"),
    solver_version: str | None = Query(default=None, alias="solverVersion"),
    limit: int = Query(default=50),
    cursor: str | None = Query(default=None),
    catalog: Catalog = Depends(get_catalog),
):
    result, revision = list_material_parameters(
        catalog,
        query=q,
        domain=domain,
        quantity_kind=quantity_kind,
        solver_name=solver_name,
        solver_version=solver_version,
        limit=limit,
        cursor=cursor,
    )
    _cache(response, revision)
    return result


@router.get("/material-parameters/{key:path}", response_model=MaterialParameterDetail)
def material_parameter(
    key: str,
    response: Response,
    catalog: Catalog = Depends(get_catalog),
):
    try:
        result, revision = get_material_parameter(catalog, key)
    except CatalogNotFoundError as error:
        raise _not_found(error) from error
    _cache(response, revision)
    return result


@router.get("/material-models", response_model=CatalogPage[MaterialModel])
def material_models(
    response: Response,
    q: str | None = Query(default=None),
    limit: int = Query(default=50),
    cursor: str | None = Query(default=None),
    catalog: Catalog = Depends(get_catalog),
):
    result, revision = list_material_models(
        catalog,
        query=q,
        limit=limit,
        cursor=cursor,
    )
    _cache(response, revision)
    return result


@router.get("/material-models/{key:path}", response_model=MaterialModel)
def material_model(
    key: str,
    response: Response,
    catalog: Catalog = Depends(get_catalog),
):
    try:
        result, revision = get_material_model(catalog, key)
    except CatalogNotFoundError as error:
        raise _not_found(error) from error
    _cache(response, revision)
    return result


@router.get("/solvers", response_model=CatalogPage[SolverSummary])
def solvers(
    response: Response,
    q: str | None = Query(default=None),
    limit: int = Query(default=50),
    cursor: str | None = Query(default=None),
    catalog: Catalog = Depends(get_catalog),
):
    result, revision = list_solvers(
        catalog,
        query=q,
        limit=limit,
        cursor=cursor,
    )
    _cache(response, revision)
    return result


@router.get("/solvers/{name}/{version}", response_model=SolverDetail)
def solver(
    name: str,
    version: str,
    response: Response,
    catalog: Catalog = Depends(get_catalog),
):
    try:
        result, revision = get_solver(catalog, name, version)
    except CatalogNotFoundError as error:
        raise _not_found(error) from error
    _cache(response, revision)
    return result


@router.get("/experiments", response_model=CatalogPage[ExperimentSummary])
def experiments(
    response: Response,
    q: str | None = Query(default=None),
    solver_name: str | None = Query(default=None, alias="solverName"),
    solver_version: str | None = Query(default=None, alias="solverVersion"),
    namespace: str | None = Query(default=None),
    repository: str | None = Query(default=None),
    limit: int = Query(default=50),
    cursor: str | None = Query(default=None),
    catalog: Catalog = Depends(get_catalog),
):
    result, revision = list_experiments(
        catalog,
        query=q,
        solver_name=solver_name,
        solver_version=solver_version,
        namespace=namespace,
        repository=repository,
        limit=limit,
        cursor=cursor,
    )
    _cache(response, revision)
    return result


@router.get("/experiments/{key}", response_model=ExperimentDetail)
def experiment(
    key: str,
    response: Response,
    namespace: str | None = Query(default=None),
    repository: str | None = Query(default=None),
    version: str | None = Query(default=None),
    catalog: Catalog = Depends(get_catalog),
):
    try:
        result, revision = get_experiment(
            catalog,
            key,
            namespace=namespace,
            repository=repository,
            version=version,
        )
    except CatalogNotFoundError as error:
        raise _not_found(error) from error
    except CatalogAmbiguousError as error:
        raise _ambiguous(error) from error
    _cache(response, revision)
    return result


@router.get("/search", response_model=CatalogSearchResponse)
def search(
    response: Response,
    q: str = Query(),
    limit: int = Query(default=30),
    catalog: Catalog = Depends(get_catalog),
):
    result, revision = search_catalog(catalog, q, limit=limit)
    _cache(response, revision)
    return result


@router.post("/runtime-slice", response_model=CatalogRuntimeSlice)
def runtime_slice(
    request: CatalogRuntimeSliceRequest,
    response: Response,
    catalog: Catalog = Depends(get_catalog),
):
    try:
        result, revision = build_runtime_slice(catalog, request)
    except CatalogNotFoundError as error:
        raise _not_found(error) from error
    _cache(response, revision)
    return result
