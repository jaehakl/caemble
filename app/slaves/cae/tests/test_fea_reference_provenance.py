"""외부 실행 없이, 준비한 기준 입력이 바뀌면 실행을 막는 경계를 확인한다."""

import hashlib
import json

import pytest

from tests.fea_reference import openfast


@pytest.mark.parametrize("change", ["modified", "missing"])
def test_reference_rejects_changed_input_before_launch(tmp_path, monkeypatch, change):
    source = tmp_path / "member.dat"
    source.write_bytes(b"explicit model input\n")
    (tmp_path / "original_settings.json").write_text(
        json.dumps({"suite": "original", "input_hashes": [
            {"path": source.name, "sha256": hashlib.sha256(source.read_bytes()).hexdigest()}
        ]}), encoding="utf-8",
    )
    if change == "modified":
        source.write_bytes(b"changed model input\n")
    else:
        source.unlink()

    def unexpected_launch(*args, **kwargs):
        pytest.fail("A mismatched input must be rejected before starting OpenFAST")

    monkeypatch.setattr(openfast.subprocess, "run", unexpected_launch)
    with pytest.raises(ValueError, match="Prepared input checksum mismatch"):
        openfast.run(tmp_path, "original", 1)


def test_reference_evidence_identifies_exact_prepared_settings(tmp_path):
    source = tmp_path / "member.dat"
    source.write_bytes(b"explicit model input\n")
    settings = {"suite": "original", "input_hashes": [
        {"path": source.name, "sha256": hashlib.sha256(source.read_bytes()).hexdigest()}
    ]}
    content = json.dumps(settings).encode("utf-8")
    (tmp_path / "original_settings.json").write_bytes(content)
    actual, evidence = openfast.verify_prepared_inputs(tmp_path, "original")
    assert actual == settings
    assert evidence["settings_sha256"] == hashlib.sha256(content).hexdigest()
    assert evidence["verified_input_count"] == 1
