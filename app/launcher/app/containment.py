"""Per-attempt process containers; reservations outlive every child process."""
from __future__ import annotations

import asyncio
import ctypes
import os
import signal
import sys
import time
from ctypes import wintypes
from pathlib import Path
from typing import Any
from uuid import uuid4

import psutil


class BasicLimits(ctypes.Structure):
    _fields_ = [("process_time", ctypes.c_longlong), ("job_time", ctypes.c_longlong),
                ("flags", wintypes.DWORD), ("min_ws", ctypes.c_size_t), ("max_ws", ctypes.c_size_t),
                ("active_limit", wintypes.DWORD), ("affinity", ctypes.c_size_t),
                ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]


class IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in ("reads", "writes", "other", "read_bytes", "write_bytes", "other_bytes")]


class ExtendedLimits(ctypes.Structure):
    _fields_ = [("basic", BasicLimits), ("io", IoCounters), ("process_memory", ctypes.c_size_t),
                ("job_memory", ctypes.c_size_t), ("peak_process_memory", ctypes.c_size_t), ("peak_job_memory", ctypes.c_size_t)]


class WindowsJob:
    def __init__(self, cpu_ids: list[int], *, name: str | None = None, existing: bool = False) -> None:
        if any(cpu < 0 or cpu >= ctypes.sizeof(ctypes.c_size_t) * 8 for cpu in cpu_ids):
            raise ValueError("This launcher supports CPU affinity within one Windows processor group")
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        for function in ("CreateJobObjectW", "OpenJobObjectW", "OpenProcess"):
            getattr(self.kernel, function).restype = wintypes.HANDLE
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.kernel.OpenJobObjectW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
        self.kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        self.kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.kernel.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
        self.kernel.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
        self.kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        self.name = name or f"Local\\Caemble-execution-{uuid4()}"
        self.handle = (self.kernel.OpenJobObjectW(0x0004 | 0x0008, False, self.name) if existing
                       else self.kernel.CreateJobObjectW(None, self.name))
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        if existing:
            return
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000 | 0x10  # KILL_ON_JOB_CLOSE | AFFINITY, no breakaway.
        limits.basic.affinity = sum(1 << cpu for cpu in cpu_ids)
        if not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            error = ctypes.WinError(ctypes.get_last_error())
            self.close()
            raise error

    def assign(self, pid: int) -> None:
        process = self.kernel.OpenProcess(0x0100 | 0x0001 | 0x1000, False, pid)
        if not process:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            contained = wintypes.BOOL()
            if not self.kernel.IsProcessInJob(process, self.handle, ctypes.byref(contained)):
                raise ctypes.WinError(ctypes.get_last_error())
            if not contained.value and not self.kernel.AssignProcessToJobObject(self.handle, process):
                raise ctypes.WinError(ctypes.get_last_error())
        finally:
            self.kernel.CloseHandle(process)

    def pids(self) -> list[int]:
        count = 64
        while True:
            class ProcessList(ctypes.Structure):
                _fields_ = [("assigned", wintypes.DWORD), ("count", wintypes.DWORD), ("pids", ctypes.c_size_t * count)]
            processes = ProcessList()
            if self.kernel.QueryInformationJobObject(self.handle, 3, ctypes.byref(processes), ctypes.sizeof(processes), None):
                return list(processes.pids[:processes.count])
            error = ctypes.get_last_error()
            if error != 234:  # ERROR_MORE_DATA
                raise ctypes.WinError(error)
            count = max(count * 2, processes.assigned)

    def kill(self) -> None:
        if not self.kernel.TerminateJobObject(self.handle, 1):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self) -> None:
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def group_pids(group_id: int) -> list[int]:
    result = []
    for process in psutil.process_iter(["pid", "status"]):
        try:
            if os.getpgid(process.pid) == group_id and process.info["status"] != psutil.STATUS_ZOMBIE:
                result.append(process.pid)
        except (ProcessLookupError, psutil.NoSuchProcess):
            continue
    return result


class ProcessContainer:
    def __init__(self) -> None:
        self.process: asyncio.subprocess.Process | None = None
        self.job: WindowsJob | None = None
        self.lifeline: int | None = None
        self.created_at: float | None = None
        self.closed = False
        self.job_name: str | None = None

    async def start(self, args: list[str], *, env: dict[str, str], cwd: Path, cpu_ids: list[int]) -> asyncio.subprocess.Process:
        read_fd = None
        kwargs: dict[str, Any] = {}
        try:
            if os.name == "nt":
                # A venv redirector creates another Python process and its own
                # Job Object before application bootstrap. Start the interpreter
                # directly using CPython's launcher contract, preserving the venv.
                executable = Path(args[0])
                config_path = executable.parent.parent / "pyvenv.cfg"
                if config_path.is_file():
                    config = dict(line.split("=", 1) for line in config_path.read_text(encoding="utf-8").splitlines() if "=" in line)
                    config = {key.strip(): value.strip() for key, value in config.items()}
                    base_executable = Path(config.get("base-executable") or config.get("executable")
                                           or str(Path(config["home"]) / executable.name))
                    if not base_executable.is_file():
                        raise RuntimeError("virtual environment base Python executable is missing")
                    env = {**env, "__PYVENV_LAUNCHER__": str(executable)}
                    args = [str(base_executable), *args[1:]]
                self.job = WindowsJob(cpu_ids)
                self.job_name = self.job.name
            else:
                read_fd, self.lifeline = os.pipe()
                args = [sys.executable, str(Path(__file__).with_name("guardian.py")), str(read_fd),
                        ",".join(str(cpu) for cpu in cpu_ids), *args]
                kwargs = {"start_new_session": True, "pass_fds": (read_fd,)}
            self.process = await asyncio.create_subprocess_exec(
                *args, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, cwd=cwd, env=env, **kwargs,
            )
            self.created_at = psutil.Process(self.process.pid).create_time()
            if self.job is not None:
                self.job.assign(self.process.pid)
            else:
                psutil.Process(self.process.pid).cpu_affinity(cpu_ids)
            return self.process
        except BaseException:
            if self.process is not None and self.process.returncode is None:
                if os.name != "nt":
                    try:
                        os.killpg(self.process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                else:
                    if self.job is not None:
                        self.job.kill()
                    # Assignment itself may have failed before the process joined.
                    if self.process.returncode is None:
                        try:
                            self.process.kill()
                        except ProcessLookupError:
                            pass
                await self.process.wait()
            self.close()
            raise
        finally:
            if read_fd is not None:
                os.close(read_fd)

    def pids(self) -> list[int]:
        if self.closed:
            return []
        if self.job is not None:
            return self.job.pids()
        return group_pids(self.process.pid) if self.process is not None else []

    def rss(self) -> int:
        total = 0
        for pid in self.pids():
            try:
                total += psutil.Process(pid).memory_info().rss
            except psutil.NoSuchProcess:
                continue
        return total

    async def stop(self, grace: float = 3.0) -> None:
        if self.closed or self.process is None:
            self.close()
            return
        known = []
        for pid in self.pids():
            try:
                known.append(psutil.Process(pid))
            except psutil.NoSuchProcess:
                pass
        if self.process.stdin is not None:
            self.process.stdin.close()
        try:
            await asyncio.wait_for(asyncio.shield(self.process.wait()), grace)
        except TimeoutError:
            pass
        if self.job is not None:
            self.job.kill()
        else:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        await self.process.wait()
        _gone, alive = await asyncio.to_thread(psutil.wait_procs, known, timeout=5)
        if alive:
            raise RuntimeError("contained processes did not exit after termination")
        deadline = time.monotonic() + 5
        while self.pids():
            if time.monotonic() >= deadline:
                raise RuntimeError("process container still owns live descendants")
            await asyncio.sleep(0.02)
        self.close()

    def journal_state(self) -> dict[str, Any]:
        return {"pid": self.process.pid if self.process else None, "created_at": self.created_at,
                "os_boot_time": psutil.boot_time(), "platform": os.name, "job_name": self.job_name}

    def close(self) -> None:
        if self.job is not None:
            self.job.close()
            self.job = None
        if self.lifeline is not None:
            os.close(self.lifeline)
            self.lifeline = None
        self.closed = True


async def recover_container(state: dict[str, Any]) -> None:
    """Old boot containers have lost their owner; wait for crash cleanup before receipts."""
    pid = state.get("pid")
    if not pid or state.get("os_boot_time") != psutil.boot_time():
        return
    if os.name == "nt" and state.get("job_name"):
        try:
            job = WindowsJob([], name=state["job_name"], existing=True)
        except OSError as error:
            if error.winerror != 2:
                raise
        else:
            try:
                job.kill()
                deadline = time.monotonic() + 5
                while job.pids():
                    if time.monotonic() >= deadline:
                        raise RuntimeError("previous launcher boot still owns a job object")
                    await asyncio.sleep(0.02)
            finally:
                job.close()
    try:
        process = psutil.Process(pid)
        if process.create_time() != state.get("created_at"):
            return
    except psutil.NoSuchProcess:
        process = None
    if os.name != "nt":
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 5
        while group_pids(pid):
            if time.monotonic() >= deadline:
                raise RuntimeError("previous launcher boot still owns a process group")
            await asyncio.sleep(0.02)
    elif process is not None:
        # Normally KILL_ON_JOB_CLOSE has already removed this tree.
        children = process.children(recursive=True)
        for child in reversed(children):
            try:
                child.kill()
            except psutil.NoSuchProcess:
                pass
        try:
            process.kill()
        except psutil.NoSuchProcess:
            pass
        _gone, alive = await asyncio.to_thread(psutil.wait_procs, children + [process], timeout=5)
        if alive:
            raise RuntimeError("previous launcher boot still owns processes")
