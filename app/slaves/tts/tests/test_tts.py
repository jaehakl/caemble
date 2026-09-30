import asyncio
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

from app import runtime
from app.models import SynthesisRequest
from app.worker import create_app
from sdk.slave import DataChannelMessage, SlaveContext


class SynthesisContractTests(unittest.TestCase):
    def test_invalid_requests_fail_before_model_loading(self):
        for payload in ({"text": " "}, {"text": "!!!"}, {"text": "x" * 2001},
                        {"text": "hello", "voice": "../voice"},
                        {"text": "hello", "speed": float("nan")},
                        {"text": "hello", "speed": 0.1}, {"text": "hello", "extra": 1}):
            with self.subTest(payload=str(payload)[:80]), self.assertRaises(ValueError):
                SynthesisRequest.model_validate(payload)

    def test_worker_dispatch_preserves_id_attachment_and_metadata(self):
        metadata = {"model": "kokoro-v1.0", "sample_rate": 24000, "input_hash": "abc"}
        fake = SimpleNamespace(synthesize=lambda *args: (b"RIFF-test", metadata))
        app = create_app()
        message = DataChannelMessage(id="request-42", type="ai.kokoro.synthesis", payload={"text": "Hello!"})
        with patch("app.worker.get_runtime", return_value=fake):
            result = asyncio.run(app.dispatch(message, SlaveContext(session_id="session", ttl_seconds=60)))
        self.assertEqual(result.id, message.id)
        self.assertEqual(result.type, "ai.kokoro.synthesis.result")
        self.assertEqual(result.payload["attachment_id"], result.attachments[0].id)
        self.assertEqual(result.attachments[0].data, b"RIFF-test")
        self.assertEqual(result.payload["input_hash"], "abc")

    def test_initializer_loads_model_once_and_failure_does_not_cache(self):
        previous = runtime._runtime
        runtime._runtime = None
        try:
            with patch("app.runtime.KokoroRuntime", side_effect=[RuntimeError("not prepared"), object()]) as factory:
                with self.assertRaises(RuntimeError):
                    runtime.get_runtime()
                first = runtime.get_runtime()
                self.assertIs(runtime.get_runtime(), first)
                self.assertEqual(factory.call_count, 2)
        finally:
            runtime._runtime = previous


class PreparedAssetsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        versions = lambda name: "0.9.4" if name in {"kokoro", "misaki"} else "test"
        self.version_patch = patch("app.runtime.metadata.version", side_effect=versions)
        self.spec_patch = patch("app.runtime.util.find_spec", return_value=object())
        self.version_patch.start()
        self.spec_patch.start()

    def tearDown(self):
        self.spec_patch.stop()
        self.version_patch.stop()
        self.temp.cleanup()

    def write_assets(self):
        files = {}
        for name in runtime.MODEL_FILES:
            path = self.directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"prepared")
            files[name] = {"size": 8, "sha256": hashlib.sha256(b"prepared").hexdigest()}
        (self.directory / "prepared.json").write_text(json.dumps({"revision": runtime.MODEL_REVISION, "files": files}), encoding="utf-8")

    def test_doctor_fails_without_prepare_and_never_downloads(self):
        with patch("subprocess.run", side_effect=AssertionError("no subprocess/network")):
            with self.assertRaisesRegex(RuntimeError, "not prepared"):
                runtime.doctor(self.directory)
            self.write_assets()
            self.assertTrue(runtime.doctor(self.directory, verify_hashes=True)["ready"])

    def test_corrupt_or_missing_assets_fail(self):
        self.write_assets()
        (self.directory / runtime.MODEL_FILES[0]).write_bytes(b"corrupt!")
        with self.assertRaisesRegex(RuntimeError, "checksum"):
            runtime.doctor(self.directory, verify_hashes=True)
        (self.directory / runtime.MODEL_FILES[1]).unlink()
        with self.assertRaisesRegex(RuntimeError, "Missing"):
            runtime.doctor(self.directory)


@unittest.skipUnless(os.environ.get("CAEMBLE_TTS_REAL_TEST") == "1", "Set CAEMBLE_TTS_REAL_TEST=1 after prepare for real synthesis")
class RealKokoroTests(unittest.TestCase):
    def test_real_cpu_synthesis_is_pcm_wave(self):
        async def execute():
            app = create_app()
            context = SlaveContext(session_id="real-smoke", ttl_seconds=120)
            # Enter after asyncio creates its Windows loopback self-pipe.
            with patch("socket.socket.connect", side_effect=AssertionError("inference must remain offline")):
                await app.run_initialize(context)
                return await app.dispatch(DataChannelMessage(id="real-1", type="ai.kokoro.synthesis",
                    payload={"text": "I used to get up early."}), context)

        response = asyncio.run(execute())
        self.assertEqual(response.id, "real-1")
        wav, metadata = response.attachments[0].data, response.payload
        with wave.open(io.BytesIO(wav), "rb") as stream:
            self.assertEqual(stream.getnchannels(), 1)
            self.assertEqual(stream.getsampwidth(), 2)
            self.assertEqual(stream.getframerate(), 24000)
            self.assertGreater(stream.getnframes(), 2400)
        self.assertEqual(metadata["input_hash"], hashlib.sha256(b"I used to get up early.").hexdigest())
        self.assertEqual(metadata["audio_sha256"], hashlib.sha256(wav).hexdigest())
        self.assertEqual(metadata["device"], "cpu")
        self.assertEqual(metadata["preprocessing_version"], "kokoro-0.9.4-misaki-0.9.4-v1")


if __name__ == "__main__":
    unittest.main()
