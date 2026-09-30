from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tomllib
import sys

PROJECT = Path(__file__).resolve().parents[1]


def child_environment() -> dict[str, str]:
    allowed = {"path", "pathext", "systemroot", "windir", "comspec", "temp", "tmp",
               "home", "userprofile", "appdata", "localappdata", "lang", "lc_all",
               "omp_num_threads", "openblas_num_threads", "mkl_num_threads"}
    return {key: value for key, value in os.environ.items() if key.lower() in allowed}


# The checkout-owned installer is shared with the CLI bootstrap.
sys.path.insert(0, str(PROJECT.parents[2] / "app/ui/scripts"))
from node_runtime import bundle_metadata, current_runtime, prepare_runtime


def prepare(project: Path = PROJECT) -> dict:
    return prepare_runtime(project.parents[2])


def doctor(project: Path = PROJECT) -> dict:
    config_path = project / "runtime.toml"
    config = tomllib.loads(config_path.read_text(encoding="utf-8")) if config_path.exists() else {}
    node = shutil.which(config.get("node", "node"))
    if node is None:
        raise RuntimeError("Node 24.14+ is required; install Node or set node in evaluation/runtime.toml.")
    version = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=10,
                             env=child_environment(), check=True,
                             creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0).stdout.strip()
    if tuple(int(part) for part in version.removeprefix("v").split(".")[:2]) < (24, 14):
        raise RuntimeError(f"Node 24.14+ is required; found {version}.")
    directory = current_runtime(project.parents[2])
    raw = bundle_metadata(directory)
    return {"ready": True, "node": node, "node_version": version,
            "worker": str(directory / "worker.cjs"), "runtime_id": hashlib.sha256(raw).hexdigest()}


class EvaluationError(RuntimeError):
    def __init__(self, error: dict):
        super().__init__(error.get("message", "Evaluation failed."))
        self.code = error.get("code", "evaluation_error")
        self.diagnostics = error.get("diagnostics", [])


async def run_node(request: dict, runtime: dict, *, timeout: float = 120) -> dict:
    with tempfile.TemporaryDirectory(prefix="caemble-evaluation-") as directory:
        folder = Path(directory)
        input_path, output_path = folder / "input.json", folder / "output.json"
        input_path.write_text(json.dumps({"operation": "evaluate", "evaluation": request}, ensure_ascii=False, allow_nan=False), encoding="utf-8")
        child = await asyncio.create_subprocess_exec(
            runtime["node"], runtime["worker"], cwd=folder, env=child_environment(),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}),
        )
        # Do not detach: launcher containment must include this child and its descendants.
        communication = asyncio.create_task(child.communicate(json.dumps({
            "input_file": str(input_path), "output_file": str(output_path),
        }).encode("utf-8")))
        try:
            stdout, _stderr = await asyncio.wait_for(asyncio.shield(communication), timeout)
            reply = json.loads(stdout.decode("utf-8"))
            if child.returncode != 0 or "error" in reply:
                raise EvaluationError(reply.get("error", {"message": f"Node exited with {child.returncode}."}))
            return json.loads(output_path.read_text(encoding="utf-8"))
        except TimeoutError as error:
            raise EvaluationError({"code": "timeout", "message": "Evaluation child timed out."}) from error
        finally:
            if child.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    child.kill()
            await child.wait()
            await asyncio.gather(communication, return_exceptions=True)
