from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from runtime_state import RuntimeRegistry
from sdk.protocol.messages import parse_launcher_message
from service import job_orchestrator as orchestrator_module
from service.job_orchestrator import JobOrchestrator, LauncherPolicyViolation
from service.job_service import JobService
from tests.helpers import create_user
from user_auth.db import Job, Launcher


class FakeWebSocket:
    def __init__(self):
        self.sent = []
        self.closed = []

    async def send_json(self, payload):
        self.sent.append(payload)

    async def close(self, code=1000):
        self.closed.append(code)


@pytest.mark.asyncio
async def test_dispatch_is_same_user_serial_and_cancellation_reset_are_ordered(
    db_session,
    monkeypatch,
):
    first_user = await create_user(db_session)
    second_user = await create_user(db_session)
    now = datetime.now(timezone.utc)
    launcher = Launcher(
        user_id=first_user.id,
        launcher_name="serial-launcher",
        status="ready",
        slave_app_ids=["cae"],
        connected_at=now,
        last_heartbeat_at=now,
    )
    db_session.add(launcher)
    await db_session.commit()

    second_user_job = await JobService.create_job(
        db_session,
        user_id=str(second_user.id),
        handler_type="cae.simulation.start",
        slave_app_id="cae",
        offer={"type": "offer", "sdp": "v=0-second"},
    )
    first_job = await JobService.create_job(
        db_session,
        user_id=str(first_user.id),
        handler_type="cae.simulation.start",
        slave_app_id="cae",
        offer={"type": "offer", "sdp": "v=0-first"},
    )
    second_job = await JobService.create_job(
        db_session,
        user_id=str(first_user.id),
        handler_type="cae.simulation.start",
        slave_app_id="cae",
        offer={"type": "offer", "sdp": "v=0-next"},
    )
    second_user_job.created_at = now - timedelta(minutes=2)
    first_job.created_at = now - timedelta(minutes=1)
    second_job.created_at = now
    await db_session.commit()

    session_factory = async_sessionmaker(
        bind=db_session.bind,
        class_=AsyncSession,
        expire_on_commit=False,
        join_transaction_mode="create_savepoint",
    )
    monkeypatch.setattr(orchestrator_module, "SessionLocal", session_factory)
    registry = RuntimeRegistry()
    orchestrator = JobOrchestrator(registry)
    websocket = FakeWebSocket()
    launcher_id = str(launcher.id)
    await registry.register_launcher(launcher_id, websocket, "launcher-access-key")

    assert await orchestrator.dispatch_available_jobs() == 1
    await db_session.refresh(first_job)
    await db_session.refresh(second_job)
    await db_session.refresh(second_user_job)
    assert first_job.state == "assigned"
    assert second_job.state == "queued"
    assert second_user_job.state == "queued"
    assert [message["job_id"] for message in websocket.sent] == [str(first_job.id)]

    with pytest.raises(LauncherPolicyViolation, match="does not match"):
        await orchestrator.handle_launcher_job_event(
            db_session,
            launcher_id=launcher_id,
            user_id=str(first_user.id),
            message=parse_launcher_message(
                {"type": "job.result", "job_id": str(second_user_job.id)}
            ),
        )

    await orchestrator.handle_launcher_job_event(
        db_session,
        launcher_id=launcher_id,
        user_id=str(first_user.id),
        message=parse_launcher_message(
            {
                "type": "job.answer",
                "job_id": str(first_job.id),
                "answer": {"type": "answer", "sdp": "v=0-answer"},
            }
        ),
    )
    await orchestrator.handle_launcher_job_event(
        db_session,
        launcher_id=launcher_id,
        user_id=str(first_user.id),
        message=parse_launcher_message(
            {"type": "job.running", "job_id": str(first_job.id)}
        ),
    )
    await orchestrator.handle_launcher_job_event(
        db_session,
        launcher_id=launcher_id,
        user_id=str(first_user.id),
        message=parse_launcher_message(
            {"type": "job.result", "job_id": str(first_job.id)}
        ),
    )

    assert await orchestrator.dispatch_available_jobs() == 1
    await db_session.refresh(first_job)
    await db_session.refresh(second_job)
    assert first_job.state == "succeeded"
    assert second_job.state == "assigned"
    assert [message["job_id"] for message in websocket.sent if message["type"] == "job.start"] == [
        str(first_job.id),
        str(second_job.id),
    ]

    await orchestrator.handle_launcher_job_event(
        db_session,
        launcher_id=launcher_id,
        user_id=str(first_user.id),
        message=parse_launcher_message(
            {
                "type": "job.answer",
                "job_id": str(second_job.id),
                "answer": {"type": "answer", "sdp": "v=0-answer-two"},
            }
        ),
    )
    await orchestrator.handle_launcher_job_event(
        db_session,
        launcher_id=launcher_id,
        user_id=str(first_user.id),
        message=parse_launcher_message(
            {"type": "job.running", "job_id": str(second_job.id)}
        ),
    )
    killed = await orchestrator.kill_job(
        db_session,
        job_id=str(second_job.id),
        user_id=str(first_user.id),
        reason="test cancellation",
    )
    assert killed is not None
    assert killed.state == "running"
    assert killed.cancel_requested_at is not None
    assert websocket.sent[-1] == {
        "type": "job.cancel",
        "job_id": str(second_job.id),
        "reason": "test cancellation",
    }
    await orchestrator.handle_launcher_job_event(
        db_session,
        launcher_id=launcher_id,
        user_id=str(first_user.id),
        message=parse_launcher_message(
            {
                "type": "job.cancelled",
                "job_id": str(second_job.id),
                "reason": "cancelled",
            }
        ),
    )
    await db_session.refresh(second_job)
    assert second_job.state == "cancelled"
    assert (await registry.get_launcher(launcher_id)).current_job_id is None

    reset_job = await JobService.create_job(
        db_session,
        user_id=str(first_user.id),
        handler_type="cae.simulation.start",
        slave_app_id="cae",
        offer={"type": "offer", "sdp": "v=0-reset"},
    )
    reset_job_id = str(reset_job.id)
    assert await orchestrator.dispatch_available_jobs() == 1
    await orchestrator.handle_launcher_job_event(
        db_session,
        launcher_id=launcher_id,
        user_id=str(first_user.id),
        message=parse_launcher_message(
            {
                "type": "job.answer",
                "job_id": reset_job_id,
                "answer": {"type": "answer", "sdp": "v=0-reset-answer"},
            }
        ),
    )
    await orchestrator.handle_launcher_job_event(
        db_session,
        launcher_id=launcher_id,
        user_id=str(first_user.id),
        message=parse_launcher_message(
            {"type": "job.running", "job_id": reset_job_id}
        ),
    )
    assert await orchestrator.reset_launcher_worker(
        db_session,
        launcher_id=launcher_id,
        user_id=str(first_user.id),
    )
    snapshot = await registry.get_launcher(launcher_id)
    assert snapshot.resetting is True
    assert websocket.sent[-1] == {
        "type": "worker.reset",
        "reason": "reset by website",
    }
    await db_session.refresh(reset_job)
    assert reset_job.state == "running"
    assert reset_job.cancel_requested_at is not None
    assert str(reset_job.launcher_id) == launcher_id
    await orchestrator.handle_launcher_job_event(
        db_session,
        launcher_id=launcher_id,
        user_id=str(first_user.id),
        message=parse_launcher_message(
            {
                "type": "job.cancelled",
                "job_id": reset_job_id,
                "reason": "worker reset",
            }
        ),
    )
    await orchestrator.handle_launcher_job_event(
        db_session,
        launcher_id=launcher_id,
        user_id=str(first_user.id),
        message=parse_launcher_message({"type": "worker.reset.done"}),
    )
    await db_session.refresh(reset_job)
    snapshot = await registry.get_launcher(launcher_id)
    assert reset_job.state == "cancelled"
    assert snapshot.current_job_id is None
    assert snapshot.resetting is False
    assert snapshot.worker_status == "idle"

    await registry.remove_launcher(launcher_id)
    replacement = FakeWebSocket()
    await registry.register_launcher(launcher_id, replacement, "replacement-key")
    assert (await registry.get_launcher(launcher_id)).websocket is replacement
