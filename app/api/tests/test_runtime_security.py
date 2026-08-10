from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from gpstation.db import APIKey, Job, Launcher
from gpstation.service.auth_service import authenticate_db_authorization
from tests.helpers import create_user
from user_auth.utils.auth_utils import hash_token


async def add_access_key(
    db_session,
    user,
    secret,
    *,
    scopes,
    rate_limit_per_minute=None,
    allowed_ips=None,
    allowed_origins=None,
):
    access_key = APIKey(
        user_id=user.id,
        key_type="user_api",
        name="runtime test",
        key_prefix=secret[:16],
        key_hash=hash_token(secret),
        scopes=scopes,
        status="active",
        rate_limit_per_minute=rate_limit_per_minute,
        allowed_ips=allowed_ips,
        allowed_origins=allowed_origins,
    )
    db_session.add(access_key)
    await db_session.commit()
    return access_key


@pytest.mark.asyncio
async def test_v1_jobs_and_launchers_are_isolated_by_user(client, db_session):
    first = await create_user(db_session)
    second = await create_user(db_session)
    first_secret = "csk_first-user-isolation-secret"
    second_secret = "csk_second-user-isolation-secret"
    await add_access_key(db_session, first, first_secret, scopes=["client"])
    await add_access_key(db_session, second, second_secret, scopes=["client"])
    now = datetime.now(timezone.utc)
    first_launcher = Launcher(
        user_id=first.id,
        launcher_name="first",
        status="ready",
        slave_app_ids=["cae"],
        connected_at=now,
        last_heartbeat_at=now,
    )
    second_launcher = Launcher(
        user_id=second.id,
        launcher_name="second",
        status="ready",
        slave_app_ids=["cae"],
        connected_at=now,
        last_heartbeat_at=now,
    )
    second_job = Job(
        user_id=second.id,
        handler_type="cae.simulation.start",
        slave_app_id="cae",
        offer={"type": "offer", "sdp": "v=0"},
        progress=[],
        state="queued",
    )
    db_session.add_all([first_launcher, second_launcher, second_job])
    await db_session.commit()
    first_launcher_id = str(first_launcher.id)
    second_job_id = str(second_job.id)

    first_headers = {"Authorization": f"Bearer {first_secret}"}
    second_headers = {"Authorization": f"Bearer {second_secret}"}
    first_launchers = await client.get("/v1/launchers", headers=first_headers)
    assert first_launchers.status_code == 200
    assert [row["id"] for row in first_launchers.json()] == [first_launcher_id]
    assert (
        await client.get(f"/v1/jobs/{second_job_id}", headers=first_headers)
    ).status_code == 404
    assert (
        await client.post(f"/v1/jobs/{second_job_id}/kill", headers=first_headers)
    ).status_code == 404
    assert (
        await client.get(f"/v1/jobs/{second_job_id}", headers=second_headers)
    ).status_code == 200


@pytest.mark.asyncio
async def test_access_key_ip_origin_and_rate_limit_policies(db_session):
    user = await create_user(db_session)
    secret = "csk_policy-test-secret"
    await add_access_key(
        db_session,
        user,
        secret,
        scopes=["client"],
        rate_limit_per_minute=1,
        allowed_ips=["10.0.0.0/8"],
        allowed_origins=["https://allowed.example"],
    )
    authorization = f"Bearer {secret}"

    with pytest.raises(HTTPException) as wrong_ip:
        await authenticate_db_authorization(
            db_session,
            authorization,
            client_ip="192.168.1.2",
            origin="https://allowed.example",
        )
    assert wrong_ip.value.status_code == 403

    with pytest.raises(HTTPException) as wrong_origin:
        await authenticate_db_authorization(
            db_session,
            authorization,
            client_ip="10.1.2.3",
            origin="https://blocked.example",
        )
    assert wrong_origin.value.status_code == 403

    principal = await authenticate_db_authorization(
        db_session,
        authorization,
        client_ip="10.1.2.3",
        origin="https://allowed.example",
    )
    assert principal.user_id == str(user.id)
    with pytest.raises(HTTPException) as limited:
        await authenticate_db_authorization(
            db_session,
            authorization,
            client_ip="10.1.2.3",
            origin="https://allowed.example",
        )
    assert limited.value.status_code == 429
