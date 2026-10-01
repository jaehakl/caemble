"""Short lived, revision-scoped access; never forward account credentials."""
import hashlib
import time
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import HTTPException
import jwt
from sqlalchemy import select

from prediction.common import canonical_bytes, owned
from prediction.db import Dataset, DatasetGrant, DatasetObject, DatasetRevision
from settings import settings
from storage.db import StorageObject
from storage.service import download_parts, reference

GRANT_SECONDS = 900
RENEWAL_SECONDS = 1800
RENEWAL_GRACE_SECONDS = 60


def grant_response(row, item, claims):
    base = f"{settings.public_api_base_url}/prediction/datasets/{row.id}/revisions/{item.revision}"
    token = jwt.encode(claims, settings.JWT_SECRET, algorithm=settings.JWT_ALG)
    return {"dataset_id": row.id, "revision": item.revision, "fingerprint": item.fingerprint, "grant_id": claims["jti"],
        "manifest_url": base + "/manifest", "object_url_template": base + "/objects/{object_id}",
        "refresh_url": base + "/grant/renew", "manifest_sha256": hashlib.sha256(canonical_bytes(item.payload)).hexdigest(),
        "token": token, "expires_at": claims["exp"]}


async def create_grant(db, identity, revision, user_id):
    row = await owned(db, Dataset, identity, user_id)
    item = await db.get(DatasetRevision, (row.id, revision))
    if row.source_kind != "server" or row.current_revision != revision or item is None or item.payload is None:
        raise HTTPException(410, "Dataset payload is local, retired, or deleted.")
    if not settings.JWT_SECRET:
        raise HTTPException(503, "Dataset grant signing is not configured.")
    issued = int(time.time())
    expires = issued + GRANT_SECONDS
    grant_id = str(uuid4())
    db.add(DatasetGrant(id=grant_id, dataset_id=row.id, revision=revision,
        expires_at=datetime.fromtimestamp(expires, timezone.utc)))
    claims = {"typ": "prediction_dataset", "sub": user_id, "dataset": row.id, "revision": revision,
        "fingerprint": item.fingerprint, "iat": issued, "renewal_exp": issued + RENEWAL_SECONDS,
        "exp": expires, "jti": grant_id}
    await db.commit()
    return grant_response(row, item, claims)


async def granted_scope(db, identity, revision, authorization, *, renew=False):
    token = authorization.removeprefix("Bearer ") if authorization.startswith("Bearer ") else ""
    try:
        claims = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALG],
            options={"verify_exp": not renew,
                "require": ["exp", "iat", "renewal_exp", "sub", "typ", "dataset", "revision", "fingerprint", "jti"]})
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Dataset read grant is invalid or expired.") from None
    if claims["typ"] != "prediction_dataset" or claims["dataset"] != str(identity) or claims["revision"] != revision:
        raise HTTPException(403, "Dataset read grant does not cover this revision.")
    query = select(Dataset).where(Dataset.id == str(identity))
    row = await db.scalar(query.with_for_update() if renew else query)
    now = time.time()
    if (any(type(claims[key]) is not int for key in ("exp", "iat", "renewal_exp"))
            or claims["renewal_exp"] > claims["iat"] + RENEWAL_SECONDS
            or claims["renewal_exp"] <= now or claims["exp"] > claims["renewal_exp"]
            or (renew and claims["exp"] + RENEWAL_GRACE_SECONDS <= now)):
        raise HTTPException(401, "Dataset grant renewal window expired.")
    item = await db.get(DatasetRevision, (str(identity), revision))
    lease = await db.get(DatasetGrant, claims["jti"])
    if (row is None or row.user_id != claims["sub"] or row.state not in {"active", "deleting"} or row.current_revision != revision
            or item is None or item.payload is None or item.fingerprint != claims["fingerprint"]
            or lease is None or lease.dataset_id != str(identity) or lease.revision != revision
            or lease.expires_at.timestamp() + (RENEWAL_GRACE_SECONDS if renew else 0) <= now):
        raise HTTPException(410, "Dataset payload was retired or deleted.")
    return row, item, lease, claims


async def read_granted_revision(db, identity, revision, authorization):
    _, item, _, _ = await granted_scope(db, identity, revision, authorization)
    return item


async def renew_grant(db, identity, revision, authorization):
    row, item, lease, claims = await granted_scope(db, identity, revision, authorization, renew=True)
    # Keep the original issue time and absolute deadline. Renewing a scoped
    # download never grants a new revision or an indefinitely held read lease.
    expires = min(int(time.time()) + GRANT_SECONDS, claims["renewal_exp"])
    lease.expires_at = datetime.fromtimestamp(expires, timezone.utc)
    await db.commit()
    return grant_response(row, item, {**claims, "exp": expires})


async def read_granted_object(db, identity, revision, object_id, authorization):
    await read_granted_revision(db, identity, revision, authorization)
    pin = await db.get(DatasetObject, (str(identity), revision, str(object_id)))
    if pin is None:
        raise HTTPException(403, "Dataset read grant does not cover this object.")
    row = await db.get(StorageObject, str(object_id))
    if row is None:
        raise HTTPException(410, "Dataset object is unavailable.")
    return await download_parts(db, reference(row))


async def release_grant(db, identity, grant_id, user_id):
    row = await owned(db, Dataset, identity, user_id, active=False)
    lease = await db.get(DatasetGrant, str(grant_id))
    if lease is not None:
        if lease.dataset_id != row.id:
            raise HTTPException(404, "Dataset grant not found.")
        await db.delete(lease)
        await db.commit()
    return {"released": True}
