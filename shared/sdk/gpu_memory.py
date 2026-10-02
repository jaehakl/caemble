"""Device/PID GPU memory snapshots without importing a numerical runtime.

WDDM owns GPU memory accounting, so NVML's per-process N/A is not zero.
Use native PDH there, identified by CUDA UUID/LUID, and nvidia-smi on Linux/TCC.
"""
from __future__ import annotations

import csv
import ctypes
import os
import re
import shutil
import subprocess
import threading
import uuid
from ctypes import wintypes


class CounterNumber(ctypes.Union):
    _fields_ = [("large", ctypes.c_longlong), ("double", ctypes.c_double), ("text", ctypes.c_wchar_p)]


class CounterValue(ctypes.Structure):
    _fields_ = [("status", wintypes.DWORD), ("number", CounterNumber)]


class CounterItem(ctypes.Structure):
    _fields_ = [("name", ctypes.c_wchar_p), ("value", CounterValue)]


class WindowsGpuCounters:
    def __init__(self):
        cuda = ctypes.WinDLL("nvcuda.dll")
        cuda.cuInit.argtypes = [ctypes.c_uint]
        cuda.cuDeviceGetCount.argtypes = [ctypes.POINTER(ctypes.c_int)]
        cuda.cuDeviceGetUuid.argtypes = [ctypes.c_void_p, ctypes.c_int]
        cuda.cuDeviceGetLuid.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint), ctypes.c_int]
        count = ctypes.c_int()
        if cuda.cuInit(0) or cuda.cuDeviceGetCount(ctypes.byref(count)):
            raise RuntimeError("CUDA GPU identity query unavailable")
        self.devices = {}
        for index in range(count.value):
            device_uuid, luid, mask = ctypes.create_string_buffer(16), ctypes.create_string_buffer(8), ctypes.c_uint()
            if cuda.cuDeviceGetUuid(device_uuid, index) or cuda.cuDeviceGetLuid(luid, ctypes.byref(mask), index):
                raise RuntimeError("CUDA UUID/LUID mapping unavailable (possibly TCC)")
            low, high = int.from_bytes(luid.raw[:4], "little"), int.from_bytes(luid.raw[4:], "little")
            for node in range(32):
                if mask.value & (1 << node):
                    self.devices[f"luid_0x{high:08x}_0x{low:08x}_phys_{node}"] = f"GPU-{uuid.UUID(bytes=device_uuid.raw)}"
        self.pdh = ctypes.WinDLL("pdh.dll")
        self.pdh.PdhOpenQueryW.argtypes = [ctypes.c_wchar_p, ctypes.c_size_t, ctypes.POINTER(wintypes.HANDLE)]
        self.pdh.PdhAddEnglishCounterW.argtypes = [wintypes.HANDLE, ctypes.c_wchar_p, ctypes.c_size_t, ctypes.POINTER(wintypes.HANDLE)]
        self.pdh.PdhCollectQueryData.argtypes = [wintypes.HANDLE]
        self.pdh.PdhGetFormattedCounterArrayW.argtypes = [wintypes.HANDLE, wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
        self.pdh.PdhCloseQuery.argtypes = [wintypes.HANDLE]
        self.query, self.counter = wintypes.HANDLE(), wintypes.HANDLE()
        if self.pdh.PdhOpenQueryW(None, 0, ctypes.byref(self.query)):
            raise RuntimeError("GPU PDH query unavailable")
        if self.pdh.PdhAddEnglishCounterW(self.query, r"\GPU Process Memory(*)\Dedicated Usage", 0, ctypes.byref(self.counter)):
            self.close()
            raise RuntimeError("GPU Process Memory counter unavailable")

    def sample(self, devices: list[str]) -> dict[str, dict[int, int]]:
        if not set(devices).issubset(self.devices.values()):
            raise RuntimeError("GPU UUID/LUID mapping incomplete")
        if self.pdh.PdhCollectQueryData(self.query):
            raise RuntimeError("GPU PDH collection failed")
        size, count = wintypes.DWORD(), wintypes.DWORD()
        status = self.pdh.PdhGetFormattedCounterArrayW(self.counter, 0x400, ctypes.byref(size), ctypes.byref(count), None)
        if status & 0xffffffff != 0x800007D2:  # PDH_MORE_DATA
            raise RuntimeError("GPU PDH snapshot unavailable")
        buffer = ctypes.create_string_buffer(size.value)
        if self.pdh.PdhGetFormattedCounterArrayW(self.counter, 0x400, ctypes.byref(size), ctypes.byref(count), buffer):
            raise RuntimeError("GPU PDH snapshot changed during collection")
        result = {device: {} for device in devices}
        for item in ctypes.cast(buffer, ctypes.POINTER(CounterItem))[:count.value]:
            match = re.fullmatch(r"pid_(\d+)_(luid_0x[0-9a-f]+_0x[0-9a-f]+_phys_\d+)", item.name.lower())
            if match is None:
                continue
            device = self.devices.get(match[2])
            if device not in result:
                continue
            if item.value.status not in (0, 1) or item.value.number.large < 0:
                raise RuntimeError("GPU PDH process measurement invalid")
            pid = int(match[1])
            result[device][pid] = result[device].get(pid, 0) + item.value.number.large
        return result

    def close(self):
        if self.query:
            self.pdh.PdhCloseQuery(self.query)
            self.query = wintypes.HANDLE()


class GpuProcessMonitor:
    def __init__(self):
        self.windows = None
        self.lock = threading.Lock()

    def sample(self, devices: list[str]) -> dict[str, dict[int, int]]:
        with self.lock:
            if not devices:
                return {}
            if os.name == "nt":
                if self.windows is None:
                    try:
                        self.windows = WindowsGpuCounters()
                    except (OSError, RuntimeError):
                        # Only TCC may fall back. A WDDM counter failure must
                        # never become a successful empty NVIDIA snapshot.
                        executable = shutil.which("nvidia-smi")
                        if executable is None:
                            raise
                        modes = subprocess.run([executable, "--query-gpu=uuid,driver_model.current",
                            "--format=csv,noheader,nounits"], capture_output=True, text=True,
                            encoding="utf-8", timeout=2, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
                        tcc = {row[0].strip() for row in csv.reader(modes.stdout.splitlines())
                               if len(row) == 2 and row[1].strip() == "TCC"}
                        if not set(devices).issubset(tcc):
                            raise RuntimeError("WDDM GPU memory counters unavailable")
                if self.windows is not None:
                    try:
                        return self.windows.sample(devices)
                    except (OSError, RuntimeError):
                        self.windows.close()
                        self.windows = None
                        raise
            executable = shutil.which("nvidia-smi")
            if executable is None:
                raise RuntimeError("nvidia-smi unavailable")
            query = subprocess.run([executable, "--query-compute-apps=gpu_uuid,pid,used_gpu_memory",
                "--format=csv,noheader,nounits"], capture_output=True, text=True, encoding="utf-8", timeout=2, check=True,
                **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))
            result = {device: {} for device in devices}
            for row in csv.reader(query.stdout.splitlines()):
                if not row or row[0].strip() not in result:
                    continue
                device, pid, mib = row[0].strip(), int(row[1]), int(row[2])
                if pid <= 0 or mib < 0:
                    raise RuntimeError("GPU process measurement invalid")
                result[device][pid] = mib * 1024 ** 2
            return result

    def close(self):
        with self.lock:
            if self.windows is not None:
                self.windows.close()
                self.windows = None
