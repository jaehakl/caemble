from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
from cae.preparation import prepare_input, run_preparation_child
from settings import settings


class PreparationProcessTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.script = Path(self.directory.name) / "prepare.cjs"
        self.script.write_text(
            'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({measurement:{},vars:{x:1},material_parameters:{}})));',
            encoding="utf-8",
        )
        self.override = patch.object(settings, "cae_preparation_script", str(self.script))
        self.override.start()

    def tearDown(self):
        self.override.stop()
        deadline = time.monotonic() + 5
        while True:
            try:
                self.directory.cleanup()
                break
            except PermissionError:
                # Windows can retain the reload child's cwd briefly after taskkill.
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.1)

    def test_selector_loop_can_prepare_node_input(self):
        loop = asyncio.SelectorEventLoop()
        try:
            result = loop.run_until_complete(prepare_input({"evaluation_timeout_ms": 3000}))
            self.assertEqual(result["vars"], {"x": 1})
        finally:
            loop.run_until_complete(loop.shutdown_default_executor())
            loop.close()

    def test_invalid_response_and_timeout_are_explicit(self):
        for output in ("null", "{}", '{"measurement":{},"vars":null,"material_parameters":{}}'):
            self.script.write_text(f"process.stdout.write({json.dumps(output)});", encoding="utf-8")
            with self.subTest(output=output), self.assertRaises(ValueError):
                run_preparation_child({"evaluation_timeout_ms": 3000}, threading.Event())
        self.script.write_text("setInterval(() => {}, 1000);", encoding="utf-8")
        with patch("cae.preparation.time.monotonic", side_effect=[0, 100]), self.assertRaisesRegex(
            TimeoutError, "63 seconds"
        ):
            run_preparation_child({"evaluation_timeout_ms": 3000}, threading.Event())

    def test_repeated_cancel_waits_for_child_reaping(self):
        self.script.write_text("setInterval(() => {}, 1000);", encoding="utf-8")
        children = []
        original = subprocess.Popen

        def start(*args, **kwargs):
            child = original(*args, **kwargs)
            children.append(child)
            return child

        async def verify():
            task = asyncio.create_task(
                prepare_input({"evaluation_timeout_ms": 3000, "padding": "x" * (2 * 1024 * 1024)})
            )
            while not children:
                await asyncio.sleep(0.01)
            await asyncio.sleep(0.1)  # Let the large write fill the unread stdin pipe.
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertIsNotNone(children[0].poll())

        with patch("cae.preparation.subprocess.Popen", side_effect=start):
            asyncio.run(verify())

    @unittest.skipUnless(sys.platform == "win32", "Windows reload regression")
    def test_actual_uvicorn_reload_can_prepare(self):
        probe = Path(self.directory.name) / "probe.py"
        probe.write_text(
            'import asyncio\nfrom fastapi import FastAPI\nfrom cae.preparation import prepare_input\napp=FastAPI()\n@app.get("/prepare")\nasync def prepare():\n result=await prepare_input({"evaluation_timeout_ms":3000})\n return {"loop":type(asyncio.get_running_loop()).__name__,"result":result}\n',
            encoding="utf-8",
        )
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        env = {
            **os.environ,
            "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "app"),
            "CAE_PREPARATION_SCRIPT": str(self.script),
        }
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "probe:app",
                "--reload",
                "--reload-dir",
                self.directory.name,
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
            ],
            cwd=self.directory.name,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        try:
            deadline = time.monotonic() + 20
            while True:
                try:
                    with urllib.request.urlopen(
                        f"http://127.0.0.1:{port}/prepare", timeout=5
                    ) as response:
                        result = json.load(response)
                    break
                except OSError:
                    if time.monotonic() > deadline:
                        raise
                    time.sleep(0.1)
            self.assertIn("Selector", result["loop"])
            self.assertEqual(result["result"]["vars"], {"x": 1})
        finally:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, check=False
            )
            process.wait(timeout=10)
