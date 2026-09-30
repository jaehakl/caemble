from fastapi import APIRouter, Depends, Request

from user_auth.schemas import UserData
from user_auth.utils.auth_wrapper import require_roles

router = APIRouter(tags=["client"])
authenticated = require_roles(["admin", "user"])


@router.get("/client/capabilities")
async def capabilities(request: Request, user: UserData = Depends(authenticated)):
    return {"protocol": 1, "builder_version": "2",
            "storage_version": 1, "object_inline_bytes": 64 * 1024,
            "catalog_revision": request.app.state.catalog.meta()["catalogRevision"],
            "chunk_bytes": 8 * 1024 * 1024,
            "authentication": ["cookie", "caemble"], "server_prepare": False}
