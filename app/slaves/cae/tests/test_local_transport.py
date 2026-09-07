from __future__ import annotations

import asyncio
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from caemble_catalog import catalog_path, open_catalog

from app.kernel.api.errors import CaeError
from app.kernel.coordinator.run import CaeRun
from app.kernel.transport import local


CAE = Path(__file__).resolve().parents[1]


@pytest.fixture
def local_input(tmp_path: Path):
    measurement = {
        "kind": "measurement",
        "experiment": {
            "sourceHash": "local-transport-source",
            "variables": {"values": list(range(10000))},
            "scene": {"geometryHash": "empty", "lengthUnit": "m", "roots": [], "geometryGroups": [], "surfaceGroups": []},
            "taskScenes": {},
            "simulationProgram": {
                "pythonSource": 'async def simulate(*, sim, tasks, vars):\n    await sim.record("signal", vars["values"])\n    await sim.record("label", "한글 결과")\n',
                "tasks": {},
                "recordedData": {"signal": {"dtype": "float64", "axes": [{"name": "x"}]}, "label": {"dtype": "string"}},
            },
        },
        "materialParameters": {"materials": {}},
        "materialWarnings": [],
        "taskMaterialParameters": {},
        "taskMaterialWarnings": {},
    }
    path = tmp_path / "한글 input.json"
    path.write_text(json.dumps({"measurement": measurement}, ensure_ascii=False), encoding="utf-8")
    with open_catalog() as catalog:
        revision = catalog.meta()["catalogRevision"]
    return path, measurement, revision


def bridge(*arguments: str, stdin: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-X", "utf8", "-m", "app.kernel.transport.local", *arguments],
        cwd=CAE, input=stdin, capture_output=True, text=True, encoding="utf-8", timeout=30,
    )


def test_doctor_and_catalog_use_checkout_sources_and_do_not_modify_sqlite():
    before = hashlib.sha256(catalog_path().read_bytes()).hexdigest()
    environment = bridge("doctor")
    assert environment.returncode == 0, environment.stderr
    report = json.loads(environment.stdout)
    assert Path(report["python"]).resolve() == Path(sys.executable).resolve()
    assert Path(report["modules"]["cae"]).resolve() == CAE / "app" / "__init__.py"
    assert Path(report["catalogPath"]).resolve() == catalog_path().resolve()
    assert report["runtimeCatalogRevision"] == report["catalogRevision"]
    assert report["dependencies"]["pytest"]["version"] == pytest.__version__
    assert all(item["available"] for item in report["dependencies"].values())
    runtime = bridge("catalog", "runtime")
    assert runtime.returncode == 0, runtime.stderr
    assert json.loads(runtime.stdout)["catalogRevision"] == report["catalogRevision"]
    example = bridge("catalog", "example", "--key", "electro-thermal-notched-bar")
    assert example.returncode == 0, example.stderr
    assert "simulate.py" in json.loads(example.stdout)["sourceBundle"]["files"]
    assert hashlib.sha256(catalog_path().read_bytes()).hexdigest() == before


def test_doctor_reports_missing_declared_dependency(monkeypatch):
    original_version = local.importlib.metadata.version

    def version(package):
        if package == "websockets":
            raise local.importlib.metadata.PackageNotFoundError(package)
        return original_version(package)

    monkeypatch.setattr(local.importlib.metadata, "version", version)
    report = local.doctor()
    assert report["ready"] is False
    assert report["dependencies"]["websockets"]["available"] is False
    assert report["dependencies"]["numpy"]["available"] is True


def test_validation_uses_existing_python_policy_and_bare_or_wrapped_input(local_input):
    path, measurement, _ = local_input
    accepted = bridge("validate", "--input", str(path))
    assert accepted.returncode == 0, accepted.stderr
    assert json.loads(accepted.stdout) == {"valid": True, "tasks": [], "recordedData": ["signal", "label"]}
    measurement["experiment"]["simulationProgram"]["pythonSource"] = (
        'async def simulate(*, sim, tasks, vars):\n    await sim.run(tasks["missing"])\n'
    )
    path.write_text(json.dumps(measurement), encoding="utf-8")
    rejected = bridge("validate", "--input", str(path))
    assert rejected.returncode == 1
    assert json.loads(rejected.stdout)["error"]["code"] == "invalid_program"
    assert "task 'missing' is not declared" in json.loads(rejected.stdout)["error"]["message"]
    error = json.loads(rejected.stdout)["error"]
    assert error["stage"] == error["language"] == "python"
    assert error["sourceHash"] == measurement["experiment"]["sourceHash"]
    assert error["referenceId"] == "experiment.simulate"
    # Policy messages can mention a line but do not expose a precise AST position.
    assert error["diagnostics"] == [{**{key: value for key, value in error.items() if key != "diagnostics"}, "location": None}]


def test_validation_preserves_real_syntax_error_location_from_existing_validator(local_input):
    from app.kernel.coordinator.program import validate_and_load_simulate

    path, measurement, _ = local_input
    source = 'async def simulate(*, sim, tasks, vars)\n    pass\n'
    measurement["experiment"]["simulationProgram"]["pythonSource"] = source
    path.write_text(json.dumps({"measurement": measurement}), encoding="utf-8")
    with pytest.raises(CaeError) as expected:
        validate_and_load_simulate(source, task_names=[], recorded_names=["signal", "label"])
    syntax_error = expected.value.__cause__
    assert isinstance(syntax_error, SyntaxError)
    rejected = bridge("validate", "--input", str(path))
    assert rejected.returncode == 1
    error = json.loads(rejected.stdout)["error"]
    assert error["code"] == expected.value.code
    assert error["message"] == str(expected.value)
    assert error["sourceHash"] == measurement["experiment"]["sourceHash"]
    assert error["stage"] == error["language"] == "python"
    assert error["referenceId"] == "experiment.simulate"
    assert error["diagnostics"][0]["location"] == {
        "file": "simulate.py", "line": syntax_error.lineno, "column": syntax_error.offset,
    }


@pytest.mark.asyncio
async def test_local_run_persists_binary_and_utf8_records_before_ack(local_input, tmp_path, monkeypatch):
    path, _, revision = local_input
    output = tmp_path / "로컬 결과"
    acknowledged = []
    original_acknowledge = CaeRun.acknowledge

    def acknowledge(run, sequence):
        packet = run.pending
        assert packet is not None and not packet.ack.done()
        record = json.loads((output / "records" / f"{sequence:04d}.json").read_text(encoding="utf-8"))
        assert record["value"] == packet.value
        for attachment, stored in zip(packet.attachments, record["attachments"], strict=True):
            assert (output / stored["path"]).read_bytes() == attachment.data
        original_acknowledge(run, sequence)
        assert packet.ack.done() and packet.attachments == []
        assert packet.resource_hold.released
        acknowledged.append(sequence)

    monkeypatch.setattr(CaeRun, "acknowledge", acknowledge)
    result = await local.run_local(path, output, revision, 10, asyncio.Event())
    assert result["state"] == "succeeded"
    assert result["recordSequences"] == acknowledged == [1, 2]
    manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["state"] == "succeeded"
    assert manifest["inputHash"] == hashlib.sha256(path.read_bytes()).hexdigest()
    binary_record = json.loads((output / manifest["records"][0]["path"]).read_text(encoding="utf-8"))
    raw = b"".join((output / item["path"]).read_bytes() for item in binary_record["attachments"])
    np.testing.assert_array_equal(np.frombuffer(raw, dtype="<f8"), np.arange(10000))
    label = json.loads((output / manifest["records"][1]["path"]).read_text(encoding="utf-8"))
    assert label["value"]["storage"] == {"kind": "inline", "value": "한글 결과"}


@pytest.mark.asyncio
async def test_record_write_failure_does_not_ack_and_closes_the_run(local_input, tmp_path, monkeypatch):
    path, _, revision = local_input
    original_write = local.write_json
    original_close = CaeRun.close
    closed = []

    def write(path, value):
        if path.name == "0001.json":
            raise OSError("disk full during record")
        original_write(path, value)

    async def close(run):
        pending = run.pending
        await original_close(run)
        closed.append(run)
        assert pending.ack.cancelled()
        assert pending.attachments == []
        assert pending.resource_hold.released

    monkeypatch.setattr(local, "write_json", write)
    monkeypatch.setattr(CaeRun, "close", close)
    result = await local.run_local(path, tmp_path / "failed", revision, 10, asyncio.Event())
    assert result["state"] == "failed"
    assert result["recordSequences"] == []
    assert result["error"]["message"] == "disk full during record"
    assert len(closed) == 1 and closed[0].closed and closed[0].simulation_api is None


@pytest.mark.asyncio
async def test_catalog_mismatch_never_creates_run_outputs(local_input, tmp_path):
    path, _, _ = local_input
    output = tmp_path / "mismatched"
    with pytest.raises(CaeError, match="local CAE uses") as error:
        await local.run_local(path, output, "wrong-catalog", 10, asyncio.Event())
    assert error.value.code == "catalog_revision_mismatch"
    assert not output.exists()


@pytest.mark.asyncio
async def test_changed_input_is_rejected_before_constructing_a_run_or_writing_outputs(local_input, tmp_path, monkeypatch):
    path, _, revision = local_input
    original = path.read_bytes()
    expected_hash = hashlib.sha256(original).hexdigest()
    path.write_bytes(original + b"\n")
    output = tmp_path / "changed-input"

    def unexpected_run(*_args, **_kwargs):
        pytest.fail("CaeRun must not be constructed for changed artifact bytes")

    monkeypatch.setattr(CaeRun, "__init__", unexpected_run)
    with pytest.raises(CaeError) as error:
        await local.run_local(path, output, revision, 10, asyncio.Event(), input_hash=expected_hash)
    assert error.value.code == "artifact_input_mismatch"
    assert not output.exists()
    rejected = bridge(
        "run", "--input", str(path), "--input-hash", expected_hash,
        "--out", str(output), "--catalog-revision", revision,
    )
    assert rejected.returncode == 4
    assert json.loads(rejected.stdout)["error"]["code"] == "artifact_input_mismatch"
    assert not output.exists()


def test_runtime_timeout_returns_timeout_exit_code_and_keeps_failed_manifest(local_input, tmp_path):
    path, _, revision = local_input
    output = tmp_path / "timed-out"
    timed_out = bridge(
        "run", "--input", str(path), "--out", str(output),
        "--catalog-revision", revision, "--timeout", "0",
    )
    assert timed_out.returncode == 5, timed_out.stderr
    result = json.loads(timed_out.stdout)
    assert result["state"] == "failed"
    assert result["error"]["code"] == "run_timeout"
    assert result["error"]["exitCode"] == 5
    assert json.loads((output / "manifest.json").read_text(encoding="utf-8"))["error"] == result["error"]


def test_stdin_cancel_finishes_and_preserves_cancelled_manifest(local_input, tmp_path):
    path, _, revision = local_input
    output = tmp_path / "cancelled"
    cancelled = bridge(
        "run", "--input", str(path), "--out", str(output), "--catalog-revision", revision,
        stdin='{"type":"cancel"}\n',
    )
    assert cancelled.returncode == 130, cancelled.stderr
    result = json.loads(cancelled.stdout)
    assert result["state"] == "cancelled"
    assert json.loads((output / "manifest.json").read_text(encoding="utf-8"))["state"] == "cancelled"


def test_success_exits_even_when_parent_keeps_stdin_open(local_input, tmp_path):
    path, _, revision = local_input
    with subprocess.Popen(
        [sys.executable, "-X", "utf8", "-m", "app.kernel.transport.local", "run",
         "--input", str(path), "--input-hash", hashlib.sha256(path.read_bytes()).hexdigest(),
         "--out", str(tmp_path / "open-stdin"), "--catalog-revision", revision],
        cwd=CAE, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8",
    ) as process:
        try:
            assert process.wait(timeout=20) == 0
            result = json.loads(process.stdout.read())
            assert result["state"] == "succeeded"
        finally:
            if process.poll() is None:
                process.kill()
