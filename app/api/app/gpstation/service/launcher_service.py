from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from gpstation.db import Launcher
from gpstation.models import LauncherView

ACTIVE_LAUNCHER_STATUSES = {"ready", "busy"}
RECONCILE_MINIMUM_AGE = timedelta(seconds=30)


def launcher_to_view(launcher: Launcher) -> LauncherView:
    return LauncherView(
        id=str(launcher.id),
        user_id=str(launcher.user_id),
        launcher_name=launcher.launcher_name,
        status=launcher.status,
        slave_app_ids=[str(item) for item in (launcher.slave_app_ids or [])],
        connected_at=launcher.connected_at.astimezone(timezone.utc),
        last_heartbeat_at=launcher.last_heartbeat_at.astimezone(timezone.utc),
        ip_address=launcher.ip_address,
        disconnected_at=launcher.disconnected_at,
    )


class LauncherService:
    @staticmethod
    async def list_launchers_for_user(
        db: AsyncSession,
        user_id: str | None,
    ) -> list[LauncherView]:
        stmt = (
            select(Launcher)
            .where(Launcher.disconnected_at.is_(None))
            .order_by(
                Launcher.last_heartbeat_at.desc(),
                Launcher.connected_at.desc(),
                Launcher.id.asc(),
            )
        )
        if user_id is not None:
            stmt = stmt.where(Launcher.user_id == user_id)
        launchers = (await db.scalars(stmt)).all()
        return [launcher_to_view(launcher) for launcher in launchers]

    @staticmethod
    async def create_connected_launcher(
        db: AsyncSession,
        *,
        user_id: str,
        launcher_name: str,
        slave_app_ids: list[str],
        ip_address: str | None,
        job_modes: dict[str, str] | None = None,
        storage_versions: dict[str, int] | None = None,
        installation_id: str, boot_id: str, session_id: str, resources: dict,
    ) -> Launcher:
        now = datetime.now(timezone.utc)
        launcher = await db.scalar(select(Launcher).where(Launcher.user_id == user_id,
            Launcher.installation_id == installation_id).with_for_update())
        if launcher is None:
            launcher = Launcher(user_id=user_id, installation_id=installation_id,
                launcher_name=launcher_name, status="ready", connected_at=now, last_heartbeat_at=now)
            db.add(launcher)
        launcher.boot_id, launcher.session_id = boot_id, session_id
        launcher.launcher_name, launcher.ip_address = launcher_name, ip_address
        launcher.status, launcher.resources = "ready", resources
        launcher.slave_app_ids = list(dict.fromkeys(slave_app_ids))
        launcher.job_modes, launcher.storage_versions = job_modes or {}, storage_versions or {}
        launcher.last_heartbeat_at = now
        launcher.disconnected_at = launcher.reconnect_deadline = None
        await db.commit()
        await db.refresh(launcher)
        return launcher

    @staticmethod
    async def mark_heartbeat(
        db: AsyncSession,
        launcher_id: str,
        status: str,
    ) -> None:
        launcher = await db.get(Launcher, launcher_id)
        if launcher is None:
            return
        launcher.status = status
        launcher.last_heartbeat_at = datetime.now(timezone.utc)
        await db.commit()

    @staticmethod
    async def find_disconnected_launcher_ids(
        db: AsyncSession,
        *,
        connected_launcher_ids: set[str],
        user_id: str | None = None,
    ) -> list[str]:
        clauses = [
            Launcher.status.in_(ACTIVE_LAUNCHER_STATUSES) | Launcher.disconnected_at.is_(None),
            Launcher.connected_at < datetime.now(timezone.utc) - RECONCILE_MINIMUM_AGE,
        ]
        if connected_launcher_ids:
            clauses.append(Launcher.id.notin_(connected_launcher_ids))
        if user_id is not None:
            clauses.append(Launcher.user_id == user_id)
        return [
            str(launcher_id)
            for launcher_id in (await db.scalars(select(Launcher.id).where(*clauses))).all()
        ]
