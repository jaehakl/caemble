import json

import pytest

import slave_registry
from slave_registry import load_slave_manifests


def write_manifest(root, folder, payload):
    path = root / folder
    path.mkdir()
    (path / "manifest.json").write_text(
        json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )


def test_manifest_registry_reads_only_direct_utf8_manifests(tmp_path):
    write_manifest(
        tmp_path,
        "cae",
        {
            "id": "cae",
            "name": "정상 상태 CAE",
            "module": "app",
            "startup_timeout_seconds": 60,
        },
    )
    nested = tmp_path / "cae" / "solvers" / "inner"
    nested.mkdir(parents=True)
    (nested / "manifest.json").write_text(
        json.dumps({"id": "must-not-load", "name": "Nested", "module": "app"}),
        encoding="utf-8",
    )

    manifests = load_slave_manifests(tmp_path)
    assert list(manifests) == ["cae"]
    assert manifests["cae"]["name"] == "정상 상태 CAE"


def test_manifest_registry_rejects_duplicates_and_missing_keys(tmp_path):
    write_manifest(tmp_path, "one", {"id": "cae", "name": "One", "module": "app"})
    write_manifest(tmp_path, "two", {"id": "cae", "name": "Two", "module": "app"})
    with pytest.raises(RuntimeError, match="Duplicate slave manifest id: cae"):
        load_slave_manifests(tmp_path)

    (tmp_path / "two" / "manifest.json").write_text(
        json.dumps({"id": "ai", "name": "AI"}),
        encoding="utf-8",
    )
    with pytest.raises(RuntimeError, match="module is required"):
        load_slave_manifests(tmp_path)


def test_manifest_registry_rejects_directory_id_mismatch(tmp_path):
    write_manifest(tmp_path, "cae", {"id": "ai", "name": "AI", "module": "app"})
    with pytest.raises(RuntimeError, match="id must match directory name cae"):
        load_slave_manifests(tmp_path)


def test_runtime_lookups_rescan_canonical_manifests(tmp_path, monkeypatch):
    write_manifest(tmp_path, "ai", {"id": "ai", "name": "AI", "module": "app"})
    monkeypatch.setattr(slave_registry, "SLAVES_DIR", tmp_path)
    assert slave_registry.registered_slave_app_ids() == ("ai",)

    write_manifest(tmp_path, "cae", {"id": "cae", "name": "CAE", "module": "app"})
    assert slave_registry.registered_slave_app_ids() == ("ai", "cae")
    slave_registry.require_slave_app_id("cae")

    (tmp_path / "cae" / "manifest.json").write_text(
        json.dumps({"id": "cae", "name": "CAE"}),
        encoding="utf-8",
    )
    with pytest.raises(RuntimeError, match="module is required"):
        slave_registry.require_slave_app_id("cae")
