from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import psutil
import pytest

from app.containment import ProcessContainer

CHILD = "import time; time.sleep(60)"
WORKER = (
    "import sys,subprocess,json,os; sys.stdin.readline(); "
    f"child=subprocess.Popen([sys.executable,'-c',{CHILD!r}]); "
    "print(json.dumps({'pid':os.getpid(),'child':child.pid}),flush=True); sys.stdin.readline()"
)


def process_alive(pid):
    try:
        process = psutil.Process(pid)
        if process.status() == psutil.STATUS_ZOMBIE:
            return False
        try:
            process.wait(0)
            return False
        except psutil.TimeoutExpired:
            return True
    except psutil.NoSuchProcess:
        return False


@pytest.mark.asyncio
async def test_real_descendants_are_contained_and_other_attempt_survives(tmp_path):
    cpu_ids = psutil.Process().cpu_affinity()[:1]
    left, right = ProcessContainer(), ProcessContainer()
    try:
        processes = []
        for container in (left, right):
            process = await container.start([sys.executable, "-c", WORKER], env=dict(os.environ), cwd=tmp_path, cpu_ids=cpu_ids)
            process.stdin.write(b"start\n")
            await process.stdin.drain()
            identity = json.loads(await asyncio.wait_for(process.stdout.readline(), 5))
            processes.append((process, identity))
            assert psutil.Process(identity["child"]).cpu_affinity() == cpu_ids
        processes[0][0].stdin.write(b"stop\n")
        await processes[0][0].stdin.drain()
        await left.stop(0.2)
        assert not process_alive(processes[0][1]["child"])
        assert process_alive(processes[1][1]["child"])
    finally:
        await left.stop(0)
        await right.stop(0)


@pytest.mark.asyncio
async def test_abrupt_launcher_death_kills_its_process_container(tmp_path):
    root = Path(__file__).resolve().parents[1]
    owner_code = (
        "import asyncio,os,sys,json,psutil; from pathlib import Path; from app.containment import ProcessContainer\n"
        "async def main():\n"
        " c=ProcessContainer()\n"
        f" p=await c.start([sys.executable,'-c',{WORKER!r}],env=dict(os.environ),cwd=Path.cwd(),cpu_ids=psutil.Process().cpu_affinity()[:1])\n"
        " p.stdin.write(b'start\\n'); await p.stdin.drain()\n"
        " print((await p.stdout.readline()).decode().strip(),flush=True)\n"
        " await asyncio.sleep(60)\n"
        "asyncio.run(main())\n"
    )
    owner = await asyncio.create_subprocess_exec(sys.executable, "-c", owner_code, cwd=root,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    identity = None
    try:
        line = await asyncio.wait_for(owner.stdout.readline(), 10)
        assert line, (await owner.stderr.read()).decode()
        identity = json.loads(line)
        owner.kill()
        await owner.wait()
        deadline = time.monotonic() + 5
        while any(process_alive(pid) for pid in identity.values()):
            assert time.monotonic() < deadline
            await asyncio.sleep(0.05)
    finally:
        if owner.returncode is None:
            owner.kill()
            await owner.wait()


@pytest.mark.asyncio
@pytest.mark.skipif(os.name != "nt", reason="Windows venv redirector")
async def test_contained_python_bypasses_redirector_and_preserves_venv(tmp_path):
    container = ProcessContainer()
    try:
        code = "import sys,os,json; sys.stdin.readline(); print(json.dumps({'pid':os.getpid(),'prefix':sys.prefix,'executable':sys.executable}),flush=True); sys.stdin.readline()"
        process = await container.start([sys.executable, "-c", code], cwd=tmp_path,
            env=dict(os.environ), cpu_ids=psutil.Process().cpu_affinity()[:1])
        process.stdin.write(b"start\n")
        await process.stdin.drain()
        identity = json.loads(await asyncio.wait_for(process.stdout.readline(), 5))
        assert identity["pid"] == process.pid  # No redirector child can escape pre-gate containment.
        assert Path(identity["prefix"]) == Path(sys.prefix)
        assert Path(identity["executable"]) == Path(sys.executable)
    finally:
        await container.stop(0)
