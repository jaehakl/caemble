from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from gpstation.db import APIKey, Job, Launcher
from gpstation.service.job_service import JobService
from settings import settings
from tests.helpers import create_user
from user_auth.db import AuthAudit
from user_auth.utils.jwt import make_access, make_refresh


def web_login(client, user) -> None:
    client.cookies.set("access_token", make_access(user))
    client.cookies.set("refresh_token", make_refresh(str(user.id)))


async def csrf_headers(client) -> dict[str, str]:
    response = await client.get("/web/auth/csrf")
    assert response.status_code == 200
    return {"X-CSRF-Token": response.json()["csrf_token"]}


@pytest.mark.asyncio
async def test_access_keys_drive_v1_jobs_and_are_revocable(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    monkeypatch.setattr(settings, "public_api_base_url", "https://api.example.com/api")
    user = await create_user(db_session)
    web_login(client, user)

    rejected = await client.post(
        "/web/users/me/access-tokens",
        json={"name": "client", "scopes": ["client"]},
    )
    assert rejected.status_code == 403

    csrf = await csrf_headers(client)
    created = await client.post(
        "/web/users/me/access-tokens",
        headers=csrf,
        json={"name": "client", "scopes": ["client"]},
    )
    assert created.status_code == 200
    secret = created.json()["secret"]
    access_key_id = created.json()["access_key"]["id"]
    assert secret.startswith("csk_")
    assert secret not in str((await db_session.get(APIKey, access_key_id)).key_hash)

    bearer = {"Authorization": f"Bearer {secret}"}
    job_response = await client.post(
        "/v1/jobs",
        headers=bearer,
        json={
            "handler_type": "cae.simulation.start",
            "slave_app_id": "cae",
            "offer": {"type": "offer", "sdp": "v=0"},
        },
    )
    assert job_response.status_code == 200
    job_id = job_response.json()["job"]["id"]
    assert job_response.json()["job"]["state"] == "queued"
    assert (
        job_response.json()["answer_wait_url"]
        == f"https://api.example.com/api/v1/jobs/{job_id}/wait-answer"
    )
    stored_job = await db_session.get(Job, job_id)
    stored_job.progress = [
        {"time": "2026-08-07T00:00:00+00:00", "progress": {"phase": "solve", "percent": 50}}
    ]
    await db_session.commit()
    web_jobs = await client.get("/web/jobs", params={"active_only": True})
    assert web_jobs.status_code == 200
    assert web_jobs.json()[0]["latest_progress"] == {
        "time": "2026-08-07T00:00:00+00:00",
        "progress": {"phase": "solve", "percent": 50},
    }

    unknown = await client.post(
        "/v1/jobs",
        headers=bearer,
        json={
            "handler_type": "unknown",
            "slave_app_id": "not-registered",
            "offer": {"type": "offer", "sdp": "v=0"},
        },
    )
    assert unknown.status_code == 400
    assert unknown.json()["detail"] == "Unknown slave_app_id: not-registered"

    wait = await client.get(
        f"/v1/jobs/{job_id}/wait-answer",
        headers=bearer,
        params={"wait_seconds": 0},
    )
    assert wait.status_code == 200
    assert wait.json() == {
        "job_id": job_id,
        "state": "queued",
        "answer": None,
        "last_error": None,
    }

    listed = await client.post(
        "/web/crud/access_keys/list",
        headers=csrf,
        json={
            "offset": 0,
            "limit": 100,
            "selected_ids": [],
            "search_text": None,
            "text_filter": {},
            "filter": {},
            "sort": ["created_at", "desc"],
        },
    )
    assert listed.status_code == 200
    assert all("key_hash" not in row and "secret" not in row for row in listed.json()["items"])

    revoked = await client.post(
        "/web/crud/access_keys/delete",
        headers=csrf,
        json={"ids": [access_key_id]},
    )
    assert revoked.status_code == 200
    assert revoked.json() == {"deleted": 1}
    assert (await client.get("/v1/launchers", headers=bearer)).status_code == 401

    audits = list(
        (
            await db_session.scalars(
                select(AuthAudit.event)
                .where(AuthAudit.user_id == user.id)
                .order_by(AuthAudit.created_at)
            )
        ).all()
    )
    assert "token_created" in audits
    assert "token_revoked" in audits


@pytest.mark.asyncio
async def test_launcher_scope_is_not_a_client_scope(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    user = await create_user(db_session)
    web_login(client, user)
    csrf = await csrf_headers(client)
    created = await client.post(
        "/web/users/me/access-tokens",
        headers=csrf,
        json={"name": "launcher", "scopes": ["launcher"]},
    )
    assert created.status_code == 200
    response = await client.get(
        "/v1/launchers",
        headers={"Authorization": f"Bearer {created.json()['secret']}"},
    )
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_v1_preflight_is_public_and_never_credentialed(client):
    response = await client.options(
        "/v1/jobs",
        headers={
            "Origin": "https://client.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization, content-type",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "*"
    assert "access-control-allow-credentials" not in response.headers
    assert "authorization" in response.headers["access-control-allow-headers"]


@pytest.mark.asyncio
async def test_startup_recovery_disconnects_launchers_and_fails_active_jobs(
    db_session,
):
    user = await create_user(db_session)
    now = datetime.now(timezone.utc)
    launcher = Launcher(
        user_id=user.id,
        launcher_name="recovery-launcher",
        status="busy",
        slave_app_ids=["cae"],
        connected_at=now,
        last_heartbeat_at=now,
    )
    db_session.add(launcher)
    await db_session.flush()
    job = Job(
        user_id=user.id,
        launcher_id=launcher.id,
        handler_type="cae.simulation.start",
        slave_app_id="cae",
        offer={"type": "offer", "sdp": "v=0"},
        state="running",
        progress=[],
    )
    db_session.add(job)
    await db_session.commit()

    recovered = await JobService.recover_after_server_restart(db_session)
    await db_session.refresh(launcher)
    await db_session.refresh(job)
    assert [str(item.id) for item in recovered] == [str(job.id)]
    assert launcher.status == "disconnected"
    assert launcher.disconnected_at is not None
    assert job.state == "failed"
    assert job.last_error == "server restarted"
