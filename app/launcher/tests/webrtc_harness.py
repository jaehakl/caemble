"""Loopback signaling fixture with real browser, launcher containment and WebRTC.

The HTTP fixture substitutes only API scheduling/storage routes. WorkerManager,
bootstrap, the master SDK and the slave transport run their production code.
"""
from __future__ import annotations

import asyncio
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlparse
from uuid import uuid4

import psutil

from app.resources import GIB, ResourceLedger, ResourcePolicy
from app.settings import LauncherSettings
from app.slave_registry import SlaveApp, SlaveAppRegistry
from app.subprocess_manager import WorkerManager

APP_ROOT = Path(__file__).resolve().parents[2]
SDK_DIST = APP_ROOT.parent / "shared/sdk/master/js/dist"
BROWSER_RUNNER = APP_ROOT.parent / "shared/sdk/master/js/tests/webrtc-browser.mjs"


class WebRtcHarness:
    def __init__(self, slave: SlaveApp, directory: Path, scenario: str, *, extra_request=None):
        self.slave, self.directory, self.scenario = slave, directory, scenario
        self.extra_request = extra_request
        self.jobs: dict[str, dict] = {}
        self.events: list[dict] = []
        self.owner_id, self.launcher_id = str(uuid4()), str(uuid4())
        self.manager = None
        self.http = None
        self.browser = None

    async def __aenter__(self):
        loop, fixture = asyncio.get_running_loop(), self

        class HttpHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.respond()

            def do_POST(self):
                self.respond()

            def log_message(self, *_):
                pass

            def respond(self):
                try:
                    raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                    result = asyncio.run_coroutine_threadsafe(
                        fixture.request(self.command, urlparse(self.path).path, json.loads(raw) if raw else None), loop,
                    ).result(timeout=45)
                    status, kind, body = result
                except Exception as error:
                    status, kind, body = 500, "application/json", json.dumps({"error": str(error)}).encode()
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), HttpHandler)
        self.http.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.http.server_address[1]}"
        self.thread = Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        policy = ResourcePolicy(gpu_count=0, cpu_cores=1, ram_budget_gb=8, ram_growth_headroom_bytes=GIB,
                                system_ram_headroom_bytes=GIB)
        ledger = ResourceLedger(policy, cpu_ids=psutil.Process().cpu_affinity()[:1], total_ram=16 * GIB)
        ledger.sample({}, launcher_rss=0, available_ram=16 * GIB, gpus=[], gpu_process_metrics_complete=True)
        settings = LauncherSettings(_env_file=None, api_url=self.url, access_token="fixture",
            rtc_ice_servers_json="[]", rtc_memory_cache_enabled="false", worker_ready_timeout_seconds=30,
            predictor_storage_root=self.directory / "storage")
        self.manager = WorkerManager(settings, self.worker_message, SlaveAppRegistry([self.slave]), ledger=ledger)
        self.manager.launcher_id, self.manager.owner_id = self.launcher_id, self.owner_id
        return self

    async def __aexit__(self, *_):
        if self.browser is not None and self.browser.returncode is None:
            parent = psutil.Process(self.browser.pid)
            children = parent.children(recursive=True)
            for process in reversed(children):
                try:
                    process.kill()
                except psutil.NoSuchProcess:
                    pass
            self.browser.kill()
            await self.browser.wait()
        if self.manager is not None:
            await self.manager.close()
        if self.http is not None:
            await asyncio.to_thread(self.http.shutdown)
            self.http.server_close()
            self.thread.join(timeout=2)

    async def worker_message(self, value):
        self.events.append(value)
        job = self.jobs.get(value.get("job_id"))
        if job is None:
            return
        kind = value["type"]
        if kind == "job.answer":
            job.update(answer=value["answer"], state="answer_ready")
            job["answered"].set()
        elif kind in {"job.running", "job.result", "job.error", "job.cancelled"}:
            job["state"] = {"job.running": "running", "job.result": "succeeded",
                            "job.error": "failed", "job.cancelled": "cancelled"}[kind]
            worker = self.manager.instances.get(value.get("instance_id"))
            if worker is not None and worker.process is not None:
                job["pid"] = worker.process.pid
            if kind == "job.error":
                job["last_error"] = value.get("detail")
                job["answered"].set()
        elif kind == "job.cleaned":
            job["cleaned"] = True
            asyncio.create_task(self.manager.acknowledge_cleanup(value))

    async def request(self, method, path, body):
        if method == "GET" and path == "/":
            return 200, "text/html", b"<!doctype html><title>WebRTC lifecycle fixture</title>"
        if method == "GET" and path.startswith("/sdk/"):
            file = (SDK_DIST / path.removeprefix("/sdk/")).resolve()
            if not file.is_relative_to(SDK_DIST.resolve()) or file.suffix != ".js":
                return 404, "text/plain", b"Not found"
            return 200, "text/javascript", file.read_bytes()
        if method == "GET" and path == "/scenario.js":
            source = "import { GpStationClient } from '/sdk/client.js';\nexport default async function () {\n"
            source += f"const launcherId = {json.dumps(self.launcher_id)};\n"
            source += "const client = new GpStationClient({apiBaseUrl:location.origin,token:'fixture',rtcConfig:{iceServers:[]}});\n"
            source += self.scenario + "\n}\n"
            return 200, "text/javascript", source.encode("utf-8")
        value = None
        if method == "POST" and path == "/v1/jobs":
            if body.get("target_launcher_id") not in {None, self.launcher_id}:
                return 404, "application/json", b'{"detail":"Unknown target launcher"}'
            identity = {"launcher_id": self.launcher_id, "boot_id": self.manager.boot_id,
                "instance_id": str(uuid4()), "job_id": str(uuid4()), "attempt_id": str(uuid4()),
                "attempt_count": 1, "reservation_id": str(uuid4())}
            job_id = identity["job_id"]
            self.jobs[job_id] = {**identity, "state": "queued", "answered": asyncio.Event(), "cleaned": False}
            # Refresh the deterministic admission sample; resource behavior has its own live tests.
            self.manager.ledger.sample({}, launcher_rss=0, available_ram=16 * GIB, gpus=[], gpu_process_metrics_complete=True)
            assignment = {**identity, "type": "job.reserve", "job_mode": "webrtc",
                "slave_app_id": self.slave.id, "handler_type": body["handler_type"],
                "resources": {"cpu_cores": 1}, "offer": body["offer"]}
            await self.manager.reserve_job(assignment)
            worker = self.manager.instances.get(identity["instance_id"])
            if worker is None:
                raise RuntimeError(f"Fixture reservation rejected: {self.events[-1]}")
            await self.manager.start_job({**assignment, "type": "job.start", "allocation": worker.allocation})
            value = {"job": {"id": job_id, "state": "queued", "slave_app_id": self.slave.id},
                     "answer_wait_url": f"{self.url}/v1/jobs/{job_id}/wait-answer"}
        elif path.startswith("/v1/jobs/"):
            _, _, _, job_id, operation = path.split("/")
            job = self.jobs[job_id]
            if method == "GET" and operation == "wait-answer":
                await asyncio.wait_for(job["answered"].wait(), timeout=30)
                value = {key: val for key, val in job.items() if key != "answered"}
            elif method == "POST" and operation == "kill":
                await self.manager.cancel_job({**{key: job[key] for key in (
                    "launcher_id", "boot_id", "instance_id", "job_id", "attempt_id", "attempt_count", "reservation_id")},
                    "reason": "fixture explicit cancellation"})
                value = {"ok": True}
        elif method == "GET" and path.startswith("/fixture/jobs/"):
            value = {key: val for key, val in self.jobs[path.split("/")[-1]].items() if key != "answered"}
        elif self.extra_request is not None:
            value = await self.extra_request(method, path, body)
        if value is None:
            return 404, "application/json", b'{"detail":"Not found"}'
        return 200, "application/json", json.dumps(value).encode("utf-8")

    async def run_browser(self, *, timeout=120, runner=BROWSER_RUNNER):
        self.browser = await asyncio.create_subprocess_exec("node", str(runner), self.url,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            **({"creationflags": 0x08000000} if os.name == "nt" else {}))
        stdout, stderr = await asyncio.wait_for(self.browser.communicate(), timeout=timeout)
        if self.browser.returncode:
            raise AssertionError(stderr.decode("utf-8", errors="replace"))
        return json.loads(stdout)
