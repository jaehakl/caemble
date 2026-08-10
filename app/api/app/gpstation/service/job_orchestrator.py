from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from db import SessionLocal
from gpstation.db import Job
from gpstation.service.access_key_service import AccessKeyService
from gpstation.service.auth_audit_service import add_auth_audit
from gpstation.service.job_service import JOB_ACTIVE_STATES, JOB_TERMINAL_STATES, JobService
from gpstation.service.launcher_service import LauncherService
from gpstation.service.state import RuntimeRegistry, runtime
from sdk.protocol.messages import (
    JobAnswer,
    JobCancelled,
    JobError,
    JobProgress,
    JobResult,
    JobRunning,
    LauncherToServerMessage,
    WorkerResetDone,
)


class LauncherPolicyViolation(RuntimeError):
    pass


LAUNCHER_SEND_TIMEOUT_SECONDS = 5


class JobOrchestrator:
    def __init__(self, registry: RuntimeRegistry = runtime) -> None:
        self.runtime = registry
        self._dispatch_wakeup = asyncio.Event()
        self._dispatcher_task: asyncio.Task[None] | None = None
        self._assignment_lock = asyncio.Lock()
        self._launcher_send_locks: dict[str, asyncio.Lock] = {}

    async def start_dispatcher(self) -> None:
        if self._dispatcher_task is not None and not self._dispatcher_task.done():
            return
        self._dispatcher_task = asyncio.create_task(self._dispatch_loop(), name="job-dispatcher")
        self.wake_dispatcher()

    async def stop_dispatcher(self) -> None:
        task = self._dispatcher_task
        self._dispatcher_task = None
        if task is None:
            return
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

    def wake_dispatcher(self) -> None:
        self._dispatch_wakeup.set()

    def launcher_send_lock(self, launcher_id: str) -> asyncio.Lock:
        return self._launcher_send_locks.setdefault(launcher_id, asyncio.Lock())

    async def send_launcher_message(self, launcher_id: str, message: dict[str, Any]) -> None:
        launcher = await self.runtime.get_launcher(launcher_id)
        if launcher is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Launcher not available",
            )
        await asyncio.wait_for(
            launcher.websocket.send_json(message),
            timeout=LAUNCHER_SEND_TIMEOUT_SECONDS,
        )

    async def disconnect_launcher(self, launcher_id: str, *, code: int = 1011) -> None:
        launcher = await self.runtime.get_launcher(launcher_id)
        await self.runtime.remove_launcher(launcher_id)
        self._launcher_send_locks.pop(launcher_id, None)
        if launcher is not None:
            with suppress(Exception):
                await launcher.websocket.close(code=code)

    async def create_job(
        self,
        db: AsyncSession,
        *,
        user_id: str,
        handler_type: str,
        slave_app_id: str,
        offer: dict[str, Any],
    ) -> Job:
        job = await JobService.create_job(
            db,
            user_id=user_id,
            handler_type=handler_type,
            slave_app_id=slave_app_id,
            offer=offer,
        )
        self.wake_dispatcher()
        return job

    async def wait_for_answer(
        self,
        db: AsyncSession,
        *,
        job_id: str,
        user_id: str | None,
        wait_seconds: float,
    ) -> Job | None:
        event = await self.runtime.prepare_job_wait(job_id)
        owns_prepared_wait = True
        try:
            job = await JobService.get_job_wait_state(db, job_id=job_id, user_id=user_id)
            should_wait = (
                job is not None
                and job.answer is None
                and job.state not in JOB_TERMINAL_STATES
                and wait_seconds > 0
            )
            if not should_wait:
                return job
            await db.rollback()
            owns_prepared_wait = False
            await self.runtime.wait_prepared_job_event(job_id, event, wait_seconds)
            return await JobService.get_job_wait_state(db, job_id=job_id, user_id=user_id)
        finally:
            if owns_prepared_wait:
                await self.runtime.release_prepared_job_event(job_id, event)

    async def kill_job(
        self,
        db: AsyncSession,
        *,
        job_id: str,
        user_id: str | None,
        reason: str,
        launcher_id: str | None = None,
        send_cancel: bool = True,
    ) -> Job | None:
        send_lock: asyncio.Lock | None = None
        active_launcher_id: str | None = None
        async with self._assignment_lock:
            job = await JobService.request_kill(
                db,
                job_id=job_id,
                user_id=user_id,
                launcher_id=launcher_id,
            )
            if job is None:
                return None
            await self.runtime.set_job_event(job_id)
            if job.launcher_id and job.state in JOB_ACTIVE_STATES:
                active_launcher_id = str(job.launcher_id)
            if send_cancel and active_launcher_id is not None:
                send_lock = self.launcher_send_lock(active_launcher_id)

        if send_lock is not None and active_launcher_id is not None:
            try:
                async with send_lock:
                    await self.send_launcher_message(
                        active_launcher_id,
                        {"type": "job.cancel", "job_id": job_id, "reason": reason},
                    )
            except asyncio.CancelledError:
                raise
            except Exception:
                failed = await JobService.fail_assigned_job(
                    db,
                    job_id=job_id,
                    launcher_id=active_launcher_id,
                    detail="launcher unavailable during cancellation",
                    state="cancelled",
                )
                if failed is not None:
                    await self.disconnect_launcher(active_launcher_id)
                    await self.runtime.set_job_event(job_id)
        self.wake_dispatcher()
        return job

    async def reset_launcher_worker(
        self,
        db: AsyncSession,
        *,
        launcher_id: str,
        user_id: str | None,
    ) -> bool:
        async with self._assignment_lock:
            launcher = await self.runtime.mark_launcher_resetting(launcher_id)
            if launcher is None:
                return False
            job_id = launcher.current_job_id
            send_lock = self.launcher_send_lock(launcher_id)
        if job_id is not None:
            await self.kill_job(
                db,
                job_id=job_id,
                user_id=user_id,
                launcher_id=launcher_id,
                reason="reset by website",
                send_cancel=False,
            )
        try:
            async with send_lock:
                await self.send_launcher_message(
                    launcher_id,
                    {"type": "worker.reset", "reason": "reset by website"},
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            if job_id is not None:
                await JobService.fail_assigned_job(
                    db,
                    job_id=job_id,
                    launcher_id=launcher_id,
                    detail="launcher unavailable during worker reset",
                    state="cancelled",
                )
                await self.runtime.set_job_event(job_id)
            await self.disconnect_launcher(launcher_id)
            self.wake_dispatcher()
            return False
        return True

    async def handle_launcher_job_event(
        self,
        db: AsyncSession,
        *,
        launcher_id: str,
        user_id: str,
        message: LauncherToServerMessage,
    ) -> None:
        if isinstance(message, WorkerResetDone):
            launcher = await self.runtime.get_launcher(launcher_id)
            if launcher is None or not launcher.resetting or launcher.current_job_id is not None:
                raise LauncherPolicyViolation("unexpected worker reset completion")
            await self.runtime.clear_launcher_worker(launcher_id)
            self.wake_dispatcher()
            return

        if not isinstance(
            message,
            (JobAnswer, JobRunning, JobProgress, JobResult, JobError, JobCancelled),
        ):
            raise LauncherPolicyViolation("unsupported launcher job event")
        if not await self.runtime.launcher_matches_job(launcher_id, message.job_id):
            raise LauncherPolicyViolation("launcher event does not match its assigned job")

        try:
            if isinstance(message, JobAnswer):
                job = await JobService.mark_launcher_answer(
                    db,
                    job_id=message.job_id,
                    launcher_id=launcher_id,
                    user_id=user_id,
                    answer=message.answer.model_dump(exclude_none=True),
                )
            elif isinstance(message, JobRunning):
                job = await JobService.mark_launcher_running(
                    db,
                    job_id=message.job_id,
                    launcher_id=launcher_id,
                    user_id=user_id,
                )
            elif isinstance(message, JobProgress):
                job = await JobService.append_launcher_progress(
                    db,
                    job_id=message.job_id,
                    launcher_id=launcher_id,
                    user_id=user_id,
                    progress=message.progress,
                )
            elif isinstance(message, JobResult):
                job = await JobService.mark_launcher_result(
                    db,
                    job_id=message.job_id,
                    launcher_id=launcher_id,
                    user_id=user_id,
                )
            else:
                detail = message.detail if isinstance(message, JobError) else message.reason
                state = "failed" if isinstance(message, JobError) else "cancelled"
                job = await JobService.mark_launcher_error(
                    db,
                    job_id=message.job_id,
                    launcher_id=launcher_id,
                    user_id=user_id,
                    detail=detail,
                    state=state,
                )
        except ValueError as error:
            raise LauncherPolicyViolation(str(error)) from error

        if job is None:
            raise LauncherPolicyViolation("launcher event violates job ownership or state")
        await self.runtime.set_job_event(message.job_id)
        if isinstance(message, (JobResult, JobError, JobCancelled)):
            await self.runtime.mark_launcher_job(launcher_id, None, worker_status="idle")
            self.wake_dispatcher()

    async def launcher_disconnected(self, db: AsyncSession, *, launcher_id: str) -> None:
        await self.runtime.remove_launcher(launcher_id)
        self._launcher_send_locks.pop(launcher_id, None)
        failed_jobs = await JobService.disconnect_launchers_and_fail_jobs(
            db,
            launcher_ids={launcher_id},
            detail="launcher disconnected",
        )
        for job in failed_jobs:
            await self.runtime.set_job_event(str(job.id))
        self.wake_dispatcher()

    async def reconcile_disconnected_launchers(
        self,
        db: AsyncSession,
        *,
        connected_launcher_ids: set[str],
        user_id: str | None,
    ) -> int:
        launcher_ids = await LauncherService.find_disconnected_launcher_ids(
            db,
            connected_launcher_ids=connected_launcher_ids,
            user_id=user_id,
        )
        launcher_ids = list(set(launcher_ids) - await self.runtime.get_launcher_ids())
        failed_jobs = await JobService.disconnect_launchers_and_fail_jobs(
            db,
            launcher_ids=launcher_ids,
            detail="launcher reconciled as disconnected",
        )
        for job in failed_jobs:
            await self.runtime.set_job_event(str(job.id))
        self.wake_dispatcher()
        return len(launcher_ids)

    async def revalidate_launcher_access_keys(self) -> int:
        targets = await self.runtime.access_key_revalidation_targets()
        if not targets:
            return 0
        async with SessionLocal() as db:
            active_key_ids = await AccessKeyService.active_launcher_key_ids(
                db,
                {access_key_id for _, access_key_id in targets},
            )
            await db.rollback()
            await self.runtime.mark_access_keys_revalidated(
                {launcher_id for launcher_id, _ in targets}
            )
            invalid_launcher_ids = {
                launcher_id
                for launcher_id, access_key_id in targets
                if access_key_id not in active_key_ids
            }
            for launcher_id in invalid_launcher_ids:
                await self.disconnect_launcher(launcher_id, code=1008)
                access_key_id = next(
                    key_id
                    for target_launcher_id, key_id in targets
                    if target_launcher_id == launcher_id
                )
                add_auth_audit(
                    db,
                    "launcher_rejected",
                    details={
                        "reason": "access_key_inactive",
                        "launcher_id": launcher_id,
                        "access_key_id": access_key_id,
                    },
                )
            failed_jobs = await JobService.disconnect_launchers_and_fail_jobs(
                db,
                launcher_ids=invalid_launcher_ids,
                detail="launcher access key is no longer active",
            )
        for job in failed_jobs:
            await self.runtime.set_job_event(str(job.id))
        if invalid_launcher_ids:
            self.wake_dispatcher()
        return len(invalid_launcher_ids)

    async def dispatch_available_jobs(self) -> int:
        dispatched = 0
        claim_error: Exception | None = None
        async with asyncio.TaskGroup() as deliveries:
            while True:
                try:
                    async with self._assignment_lock:
                        idle_launcher_ids = await self.runtime.idle_launcher_ids()
                        if not idle_launcher_ids:
                            break
                        async with SessionLocal() as db:
                            assignment = await JobService.claim_next_compatible_job(
                                db,
                                idle_launcher_ids=idle_launcher_ids,
                            )
                        if assignment is None:
                            break
                        job, launcher_id = assignment
                        job_id = str(job.id)
                        await self.runtime.mark_launcher_job(
                            launcher_id,
                            job_id,
                            loaded_slave_app_id=job.slave_app_id,
                            worker_status="assigned",
                        )
                        send_lock = self.launcher_send_lock(launcher_id)
                        await send_lock.acquire()
                        deliveries.create_task(
                            self._deliver_job_start(job, launcher_id, send_lock),
                            name=f"job-start-{job_id}",
                        )
                        dispatched += 1
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    claim_error = error
                    break
        if claim_error is not None:
            raise claim_error
        return dispatched

    async def _deliver_job_start(
        self,
        job: Job,
        launcher_id: str,
        send_lock: asyncio.Lock,
    ) -> None:
        job_id = str(job.id)
        try:
            await self.send_launcher_message(
                launcher_id,
                {
                    "type": "job.start",
                    "job_id": job_id,
                    "handler_type": job.handler_type,
                    "slave_app_id": job.slave_app_id,
                    "offer": job.offer,
                },
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            await self.disconnect_launcher(launcher_id)
            try:
                async with SessionLocal() as db:
                    await JobService.fail_assigned_job(
                        db,
                        job_id=job_id,
                        launcher_id=launcher_id,
                        detail="launcher unavailable",
                    )
                await self.runtime.set_job_event(job_id)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                print(
                    f"failed to persist launcher delivery failure for job {job_id}: {error}",
                    flush=True,
                )
        finally:
            send_lock.release()

    async def _expire_stale_jobs(self) -> None:
        async with SessionLocal() as db:
            jobs = await JobService.expire_stale_jobs(db)
        for job in jobs:
            job_id = str(job.id)
            await self.runtime.set_job_event(job_id)
            if job.launcher_id:
                launcher_id = str(job.launcher_id)
                try:
                    async with self.launcher_send_lock(launcher_id):
                        await self.send_launcher_message(
                            launcher_id,
                            {
                                "type": "job.cancel",
                                "job_id": job_id,
                                "reason": job.last_error or "job expired",
                            },
                        )
                except asyncio.CancelledError:
                    raise
                except Exception:
                    pass
                await self.disconnect_launcher(launcher_id, code=1008)

    async def _dispatch_loop(self) -> None:
        while True:
            try:
                await asyncio.wait_for(self._dispatch_wakeup.wait(), timeout=30)
            except TimeoutError:
                pass
            self._dispatch_wakeup.clear()
            try:
                await self.revalidate_launcher_access_keys()
                await self._expire_stale_jobs()
                await self.dispatch_available_jobs()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                print(f"job dispatcher failed: {error}", flush=True)


job_orchestrator = JobOrchestrator()
