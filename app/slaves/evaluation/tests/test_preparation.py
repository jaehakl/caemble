import io
import json
from pathlib import Path
import tarfile
from types import SimpleNamespace

import pytest

from app import runtime


@pytest.fixture
def project(tmp_path, monkeypatch):
    directory = tmp_path / "checkout" / "app" / "slaves" / "evaluation"
    directory.mkdir(parents=True)
    (directory.parents[2] / "deployment").mkdir()
    monkeypatch.setattr(runtime.shutil, "which", lambda _: "node")
    monkeypatch.setattr(runtime.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout="v24.14.0"))
    return directory


def write_bundle(project, revision, *, omit=()):
    files = {name: revision.encode() for name in (
        "caemble.cjs", "worker.cjs", "caemble-core.d.ts", "cad-jsx.d.ts", "lib.es5.d.ts",
    )}
    files["build-info.json"] = json.dumps({"version": "1", "inputs": {"fixture": revision}}).encode()
    archive = project.parents[2] / "deployment" / "caemble.tar.gz"
    with tarfile.open(archive, "w:gz") as target:
        for name, value in files.items():
            if name in omit:
                continue
            entry = tarfile.TarInfo(f"node/{name}")
            entry.size = len(value)
            target.addfile(entry, io.BytesIO(value))


def test_missing_bundle_is_prepared_once_and_doctor_remains_read_only(project):
    write_bundle(project, "first")
    with pytest.raises(RuntimeError, match="bundle"):
        runtime.doctor(project)
    assert not (project / "dist").exists()
    prepared = runtime.prepare(project)
    assert prepared["installed"]
    assert runtime.doctor(project)["runtime_id"] == prepared["runtime_id"]
    metadata = Path(prepared["directory"]) / "build-info.json"
    modified = metadata.stat().st_mtime_ns
    assert runtime.prepare(project) == {**prepared, "installed": False}
    assert metadata.stat().st_mtime_ns == modified
    (Path(prepared["directory"]) / "cad-jsx.d.ts").unlink()
    assert runtime.prepare(project)["installed"]
    assert runtime.doctor(project)["ready"]


def test_new_bundle_updates_and_incomplete_archive_preserves_previous_files(project):
    write_bundle(project, "first")
    first = runtime.prepare(project)
    write_bundle(project, "second")
    second = runtime.prepare(project)
    assert first["runtime_id"] != second["runtime_id"]
    assert (Path(first["directory"]) / "worker.cjs").read_text() == "first"
    assert (Path(second["directory"]) / "worker.cjs").read_text() == "second"
    write_bundle(project, "third", omit={"lib.es5.d.ts"})
    with pytest.raises(RuntimeError, match="lib.es5.d.ts"):
        runtime.prepare(project)
    assert runtime.doctor(project)["runtime_id"] == second["runtime_id"]
    assert (Path(second["directory"]) / "worker.cjs").read_text() == "second"


def test_failed_directory_swap_restores_previous_bundle(project, monkeypatch):
    write_bundle(project, "first")
    previous = runtime.prepare(project)
    write_bundle(project, "second")
    rename = Path.rename

    def fail_install(path, target):
        if path.name == "node" and path.parent.name.startswith(".prepare-"):
            raise PermissionError("fixture destination is locked")
        return rename(path, target)

    monkeypatch.setattr(Path, "rename", fail_install)
    with pytest.raises(PermissionError, match="locked"):
        runtime.prepare(project)
    assert runtime.doctor(project)["runtime_id"] == previous["runtime_id"]
    assert not list((project.parents[2] / ".data/node-runtime").glob(".prepare-*"))


def test_missing_release_archive_does_not_remove_installed_bundle(project):
    write_bundle(project, "first")
    previous = runtime.prepare(project)
    (project.parents[2] / "deployment" / "caemble.tar.gz").unlink()
    with pytest.raises(FileNotFoundError, match="caemble.tar.gz"):
        runtime.prepare(project)
    assert runtime.doctor(project)["runtime_id"] == previous["runtime_id"]


def test_simultaneous_preparation_publishes_one_complete_version(project):
    import subprocess
    import sys
    write_bundle(project, "concurrent")
    installer = Path(runtime.__file__).resolve().parents[4] / "app/ui/scripts"
    code = ("import sys,json;from pathlib import Path;sys.path.insert(0,sys.argv[1]);"
            "from node_runtime import prepare_runtime;print(json.dumps(prepare_runtime(Path(sys.argv[2]))))")
    children = [subprocess.Popen([sys.executable, "-c", code, str(installer), str(project.parents[2])],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
    results = []
    for child in children:
        output, error = child.communicate(timeout=15)
        assert child.returncode == 0, error
        results.append(json.loads(output))
    assert sorted(item["installed"] for item in results) == [False, True]
    assert results[0]["directory"] == results[1]["directory"]
    assert runtime.doctor(project)["runtime_id"] == results[0]["runtime_id"]
