from __future__ import annotations

import hashlib
from importlib import metadata, util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from threading import Lock
from typing import Any
import wave

MODEL_REPOSITORY = "hexgrad/Kokoro-82M"
MODEL_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
MODEL_FILES = ("config.json", "kokoro-v1_0.pth", "voices/af_heart.pt")
SPACY_MODEL_URL = (
    "https://github.com/explosion/spacy-models/releases/download/"
    "en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"
)
SAMPLE_RATE = 24000
_runtime: KokoroRuntime | None = None
_runtime_lock = Lock()


def model_directory() -> Path:
    configured = os.environ.get("CAEMBLE_TTS_MODEL_DIR")
    return Path(configured).expanduser().resolve() if configured else Path(__file__).resolve().parents[1] / ".models" / "kokoro-v1.0"


def doctor(directory: Path | None = None, *, verify_hashes: bool = False) -> dict[str, Any]:
    """Fast, offline readiness check used by the launcher before advertising TTS."""
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError("The TTS worker requires its own Python 3.12 environment")
    versions = {}
    for package in ("kokoro", "misaki", "torch", "spacy", "transformers", "caemble-runtime-sdk"):
        try:
            versions[package] = metadata.version(package)
        except metadata.PackageNotFoundError as error:
            raise RuntimeError(f"Missing {package}; run poetry install in app/slaves/tts_kokoro") from error
    if versions["kokoro"] != "0.9.4" or versions["misaki"] != "0.9.4":
        raise RuntimeError("Kokoro and Misaki must both be version 0.9.4")
    if util.find_spec("en_core_web_sm") is None:
        raise RuntimeError("Missing English G2P model; run python -m app prepare")
    directory = directory or model_directory()
    manifest_path = directory / "prepared.json"
    if not manifest_path.is_file():
        raise RuntimeError("Kokoro assets are not prepared; run python -m app prepare")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("revision") != MODEL_REVISION:
        raise RuntimeError("Prepared Kokoro revision differs from this worker; run prepare")
    for name in MODEL_FILES:
        asset = directory / name
        expected = manifest.get("files", {}).get(name, {})
        if not asset.is_file() or asset.stat().st_size != expected.get("size") or asset.stat().st_size == 0:
            raise RuntimeError(f"Missing or incomplete Kokoro asset: {name}; run prepare")
        if verify_hashes:
            with asset.open("rb") as stream:
                actual_digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if actual_digest != expected.get("sha256"):
                raise RuntimeError(f"Kokoro asset checksum mismatch: {name}; run prepare")
    return {"ready": True, "model": "kokoro-v1.0", "revision": MODEL_REVISION,
            "device": "cpu", "voice": "af_heart", "sample_rate": SAMPLE_RATE,
            "directory": str(directory), "packages": versions}


def prepare(directory: Path | None = None) -> dict[str, Any]:
    """Explicit installation command; the only path permitted to download models."""
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError("Create the worker environment with Python 3.12 first")
    from huggingface_hub import hf_hub_download

    directory = directory or model_directory()
    directory.mkdir(parents=True, exist_ok=True)
    if util.find_spec("en_core_web_sm") is None:
        subprocess.run([sys.executable, "-m", "pip", "install", SPACY_MODEL_URL], check=True)
    files = {}
    for name in MODEL_FILES:
        path = Path(hf_hub_download(repo_id=MODEL_REPOSITORY, filename=name,
                                   revision=MODEL_REVISION, local_dir=directory))
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        files[name] = {"size": path.stat().st_size, "sha256": digest}
    manifest = {"revision": MODEL_REVISION, "files": files}
    temporary = directory / "prepared.json.tmp"
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(directory / "prepared.json")
    return doctor(directory, verify_hashes=True)


class KokoroRuntime:
    def __init__(self, directory: Path | None = None) -> None:
        self.directory = directory or model_directory()
        self.info = doctor(self.directory, verify_hashes=True)
        # All assets are explicit local paths. These flags additionally prevent
        # future transitive library changes from contacting model hosts.
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
        import torch
        from sdk.slave.execution import configure_torch
        from misaki.espeak import EspeakFallback
        from kokoro import KModel, KPipeline

        configure_torch(torch)
        if os.environ.get("CAEMBLE_EXECUTION_JSON") is None:
            torch.set_num_threads(min(4, os.cpu_count() or 1))
        # Fail explicitly if phonemization cannot start, before KPipeline can
        # catch that error and try a different G2P implementation.
        EspeakFallback(british=False)
        model = KModel(repo_id=MODEL_REPOSITORY, config=str(self.directory / "config.json"),
                       model=str(self.directory / "kokoro-v1_0.pth")).to("cpu").eval()
        self.pipeline = KPipeline(lang_code="a", repo_id=MODEL_REPOSITORY, model=model, device="cpu")
        self.voice = torch.load(self.directory / "voices" / "af_heart.pt", map_location="cpu", weights_only=True)
        self.lock = Lock()

    def synthesize(self, text: str, voice: str = "af_heart", speed: float = 1.0) -> tuple[bytes, dict[str, Any]]:
        from app.models import SynthesisRequest
        import numpy as np
        import torch

        request = SynthesisRequest(text=text, voice=voice, speed=speed)
        with self.lock, torch.inference_mode():
            chunks = [result.audio.detach().cpu().numpy()
                      for result in self.pipeline(request.text, voice=self.voice, speed=request.speed)
                      if result.audio is not None]
        if not chunks:
            raise RuntimeError("Kokoro produced no speech")
        samples = np.concatenate(chunks).reshape(-1)
        if not samples.size or not np.isfinite(samples).all() or float(np.max(np.abs(samples))) == 0:
            raise RuntimeError("Kokoro produced empty, silent or invalid speech")
        pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2")
        output = io.BytesIO()
        with wave.open(output, "wb") as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(SAMPLE_RATE)
            stream.writeframes(pcm.tobytes())
        wav = output.getvalue()
        return wav, {
            "model": "kokoro-v1.0", "model_revision": MODEL_REVISION,
            "voice": voice, "speed": speed, "language": "en-US", "device": "cpu",
            "sample_rate": SAMPLE_RATE, "channels": 1, "duration_seconds": len(samples) / SAMPLE_RATE,
            "input_hash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "preprocessing_version": "kokoro-0.9.4-misaki-0.9.4-v1",
            "preprocessing": "kokoro-0.9.4/misaki-0.9.4; no external text normalization",
            "audio_sha256": hashlib.sha256(wav).hexdigest(),
        }


def get_runtime() -> KokoroRuntime:
    global _runtime
    with _runtime_lock:
        if _runtime is None:
            _runtime = KokoroRuntime()
        return _runtime
