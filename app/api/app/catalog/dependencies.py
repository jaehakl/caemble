from caemble_catalog import Catalog
from fastapi import HTTPException, Request


def get_catalog(request: Request) -> Catalog:
    catalog = getattr(request.app.state, "catalog", None)
    if not isinstance(catalog, Catalog):
        raise HTTPException(
            status_code=503,
            detail={"code": "catalog_unavailable", "message": "Catalog is unavailable."},
        )
    return catalog
