from pathlib import Path

from app.slave_registry import SlaveApp, SlaveAppRegistry, load_registry


def test_tts_manifests_discover_independent_ids_and_readiness(monkeypatch):
    slaves = Path(__file__).resolve().parents[2] / "slaves"
    registry = load_registry(slaves)
    assert "tts" not in registry.apps
    voicevox, kokoro = registry.require("tts_voicevox"), registry.require("tts_kokoro")
    assert voicevox.project_dir.name == "tts_voicevox"
    assert kokoro.project_dir.name == "tts_kokoro"
    assert voicevox.readiness_args == kokoro.readiness_args == ("-m", "app", "doctor")
    assert voicevox.python_executable != kokoro.python_executable

    def check(app):
        if app.id == "tts_voicevox":
            raise RuntimeError("VOICEVOX assets missing")

    monkeypatch.setattr(SlaveApp, "check_ready", check)
    selected = SlaveAppRegistry([voicevox, kokoro])
    assert selected.ready_ids() == ["tts_kokoro"]
