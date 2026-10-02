"""Advisory process-tree measurements, independent of resource admission policy.

RSS includes shared pages in each process, and peaks are sampled observations,
not operating-system high-water marks. GPU sampling never imports Torch.
"""
from __future__ import annotations

import os
from copy import deepcopy
import threading
import time

import psutil

from sdk.gpu_memory import GpuProcessMonitor


class ProcessMetrics:
    def __init__(self, gpu_devices=(), *, root_pid: int | None = None,
                 rss_interval_seconds: float = .025, gpu_interval_seconds: float = .5):
        if rss_interval_seconds <= 0 or gpu_interval_seconds <= 0:
            raise ValueError("Measurement intervals must be positive")
        self.root_pid = os.getpid() if root_pid is None else root_pid
        self.gpu_devices = tuple(dict.fromkeys(gpu_devices))
        self.rss_interval = rss_interval_seconds
        self.gpu_interval = gpu_interval_seconds
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._gpu_thread: threading.Thread | None = None
        self._monitor = GpuProcessMonitor()
        self._started: float | None = None
        self._ended: float | None = None
        self._peak_rss: int | None = None
        self._peak_vram: dict[str, int | None] = dict.fromkeys(self.gpu_devices)
        self._rss_samples = self._gpu_samples = 0
        self._cpu_times: dict[tuple[int, float], float] = {}
        self._cpu_baselines: dict[tuple[int, float], float] = {}
        self._root_created: float | None = None
        self._warnings: set[str] = set()
        self._shutdown_seconds = 0.
        self._result: dict | None = None

    def __enter__(self):
        if self._started is not None:
            raise RuntimeError("ProcessMetrics cannot be reused")
        self._started = time.perf_counter()
        self._sample_rss()
        for target in (self._rss_loop, *([self._gpu_loop] if self.gpu_devices else [])):
            thread = threading.Thread(target=target, name="process-metrics", daemon=True)
            try:
                thread.start()
            except (RuntimeError, OSError):
                self._warnings.add("Background resource measurement could not start")
            else:
                self._threads.append(thread)
                if target == self._gpu_loop:
                    self._gpu_thread = thread
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()

    def _processes(self):
        root = psutil.Process(self.root_pid)
        created = root.create_time()
        if self._root_created is not None and self._root_created != created:
            raise psutil.NoSuchProcess(self.root_pid)
        self._root_created = created
        return [root, *root.children(recursive=True)]

    def _sample_rss(self):
        try:
            processes = self._processes()
        except psutil.NoSuchProcess:
            return
        except (psutil.Error, OSError):
            with self._lock:
                self._warnings.add("Process-tree RSS measurement unavailable")
            return
        rss, count, cpu_times = 0, 0, {}
        for process in processes:
            try:
                identity = process.pid, process.create_time()
                rss += process.memory_info().rss
                timing = process.cpu_times()
                cpu_times[identity] = timing.user + timing.system
                count += 1
            except psutil.NoSuchProcess:
                continue
            except (psutil.Error, OSError):
                with self._lock:
                    self._warnings.add("A process-tree RSS sample was incomplete")
        if count:
            with self._lock:
                if self._ended is not None:
                    return
                if self._rss_samples == 0:
                    self._cpu_baselines = dict(cpu_times)
                self._peak_rss = max(self._peak_rss or 0, rss)
                self._cpu_times.update(cpu_times)
                self._rss_samples += 1

    def _rss_loop(self):
        while not self._stop.wait(self.rss_interval):
            self._sample_rss()

    def _gpu_loop(self):
        # Short requests do not pay for a fresh external GPU query. Their report
        # explicitly says unavailable when no in-window sample was collected.
        try:
            while not self._stop.wait(self.gpu_interval):
                self._sample_gpu()
        finally:
            # The observer owns the backend lock. An in-flight OS query must
            # never keep the model request or cancellation waiting for it.
            self._close_monitor()

    def _sample_gpu(self):
        if self._stop.is_set():
            return
        try:
            identities = {process.pid: process.create_time() for process in self._processes()}
            usage = self._monitor.sample(list(self.gpu_devices))
            current = {process.pid: process.create_time() for process in self._processes()}
            live = {pid for pid, created in identities.items() if current.get(pid) == created}
            values = {device: sum(value for pid, value in usage[device].items() if pid in live)
                      for device in self.gpu_devices}
            with self._lock:
                if self._ended is None:
                    for device, value in values.items():
                        self._peak_vram[device] = max(self._peak_vram[device] or 0, value)
                    self._gpu_samples += 1
        except Exception:
            with self._lock:
                self._warnings.add("Process-tree GPU measurement unavailable")

    def snapshot(self) -> dict:
        if self._started is None:
            raise RuntimeError("ProcessMetrics has not started")
        with self._lock:
            if self._result is not None:
                return deepcopy(self._result)
            return {"version": 1, "scope": "process-tree",
                    "elapsedSeconds": (self._ended or time.perf_counter()) - self._started,
                    "peakRssBytes": self._peak_rss,
                    "rssStatus": "measured" if self._rss_samples else "unavailable",
                    "peakVramBytes": dict(self._peak_vram),
                    "gpuStatus": ("not-requested" if not self.gpu_devices else
                                  "measured" if self._gpu_samples else "unavailable"),
                    "rssSamples": self._rss_samples, "gpuSamples": self._gpu_samples,
                    "rssIntervalSeconds": self.rss_interval, "gpuIntervalSeconds": self.gpu_interval,
                    "sampledCpuSeconds": sum(value - self._cpu_baselines.get(identity, 0.)
                                             for identity, value in self._cpu_times.items()),
                    "samplingShutdownSeconds": self._shutdown_seconds,
                    "warnings": sorted(self._warnings)}

    @property
    def result(self) -> dict:
        if self._ended is None:
            raise RuntimeError("ProcessMetrics is still running")
        return self.snapshot()

    def close(self):
        if self._started is None or self._ended is not None:
            return
        self._sample_rss()
        with self._lock:
            self._ended = time.perf_counter()
        self._stop.set()
        started = time.perf_counter()
        deadline = started + .05
        for thread in self._threads:
            thread.join(max(0., deadline - time.perf_counter()))
        if any(thread.is_alive() for thread in self._threads):
            with self._lock:
                self._warnings.add("Resource measurement is finishing after the operation")
        if self._gpu_thread is None:
            self._close_monitor()
        self._shutdown_seconds = time.perf_counter() - started
        self._result = self.snapshot()

    def _close_monitor(self):
        try:
            self._monitor.close()
        except Exception:
            with self._lock:
                self._warnings.add("GPU measurement shutdown failed")
