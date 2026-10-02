import asyncio
import ctypes
import json
import io
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import wave
from unittest.mock import Mock, patch

from app import runtime
from app.worker import create_app
from sdk.slave import DataChannelMessage, SlaveContext


class ContractTests(unittest.TestCase):
    def test_all_handlers_preserve_wire_contract(self):
        fake = SimpleNamespace(speakers=lambda: [{"name": "voice"}],
                               create_audio_query=lambda *a: {"accent_phrases": []},
                               synthesis=lambda *a: b"RIFF-test")
        context = SlaveContext(session_id="session", ttl_seconds=60)
        for handler, payload, expected in (
            ("speakers", {}, {"speakers": [{"name": "voice"}]}),
            ("audio_query", {"text": "こんにちは", "speaker": 3}, {"audio_query": {"accent_phrases": []}}),
            ("synthesis", {"audio_query": {}, "speaker": 3},
             {"attachment_id": "audio-1", "mime_type": "audio/wav", "size": 9}),
        ):
            with self.subTest(handler=handler), patch("app.handlers.get_voicevox_runtime", return_value=fake):
                message = DataChannelMessage(id="request-42", type=f"ai.voicevox.{handler}", payload=payload)
                result = asyncio.run(create_app().dispatch(message, context))
                self.assertEqual((result.id, result.type), (message.id, message.type + ".result"))
                self.assertEqual(result.payload, expected)
                if handler == "synthesis":
                    self.assertEqual(result.attachments[0].data, b"RIFF-test")
                    self.assertEqual(result.attachments[0].id, "audio-1")

    def test_worker_initializes_runtime_before_requests(self):
        with patch("app.worker.get_voicevox_runtime") as get:
            asyncio.run(create_app().run_initialize(SlaveContext(session_id="session", ttl_seconds=60)))
            get.assert_called_once_with()


class AllocationTests(unittest.TestCase):
    def test_device_selection_and_override_rejection(self):
        for devices, expected in (([], "cpu"), (["GPU-physical-3"], "cuda")):
            context = SimpleNamespace(allocation=SimpleNamespace(gpu_devices=devices))
            with patch("app.runtime.execution_context", return_value=context):
                self.assertEqual(runtime.execution_device(), expected)
                with self.assertRaisesRegex(ValueError, "match"):
                    runtime.execution_device("cuda" if expected == "cpu" else "cpu")
        context.allocation.gpu_devices = ["GPU-a", "GPU-b"]
        with patch("app.runtime.execution_context", return_value=context):
            with self.assertRaisesRegex(ValueError, "at most one"):
                runtime.execution_device()
        with patch("app.runtime.execution_context", return_value=None):
            self.assertEqual(runtime.execution_device(), "cpu")
            self.assertEqual(runtime.execution_device("cuda"), "cuda")

    def test_cpu_threads_follow_sdk_allocation(self):
        context = SimpleNamespace(allocation=SimpleNamespace(cpu_cores=2, gpu_devices=[]))
        for requested, expected in ((0, 2), (1, 1), (20, 2)):
            with patch("app.runtime._runtime", None), patch("app.runtime.execution_context", return_value=context), \
                 patch("sdk.slave.execution.execution_context", return_value=context), \
                 patch.object(runtime.settings, "voicevox_cpu_num_threads", requested), \
                 patch("app.runtime.VoicevoxRuntime") as factory:
                runtime.get_voicevox_runtime()
                self.assertEqual(factory.call_args.args[1:], (expected, "cpu"))
                factory.return_value.initialize.assert_called_once()

    def test_failed_initialization_is_not_cached(self):
        failed, good = Mock(), Mock(device="cpu")
        failed.initialize.side_effect = RuntimeError("initialization failed")
        with patch("app.runtime._runtime", None), patch("app.runtime.execution_context", return_value=None), \
             patch("app.runtime.VoicevoxRuntime", side_effect=[failed, good]) as factory:
            with self.assertRaises(RuntimeError):
                runtime.get_voicevox_runtime()
            self.assertIs(runtime.get_voicevox_runtime(), good)
            self.assertIs(runtime.get_voicevox_runtime(), good)
            self.assertEqual(factory.call_count, 2)


class NativeLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        names = ("voicevox_core.dll", "voicevox_onnxruntime.dll") if os.name == "nt" else (
            "libvoicevox_core.so", "libvoicevox_onnxruntime.so.1.17.3")
        for name in (*names, "sys.dic", "0.vvm", "zlibwapi.dll"):
            (self.directory / name).write_bytes(b"fixture")
        self.library = Mock()
        self.library.voicevox_get_onnxruntime_lib_versioned_filename.return_value = names[1].encode()
        self.library.voicevox_make_default_load_onnxruntime_options.return_value = runtime.VoicevoxLoadOnnxruntimeOptions()
        self.library.voicevox_make_default_initialize_options.side_effect = runtime.VoicevoxInitializeOptions
        self.library.voicevox_error_result_to_message.return_value = b"fixture native failure"
        self.library.voicevox_onnxruntime_load_once.side_effect = self.pointer_result
        self.library.voicevox_open_jtalk_rc_new.side_effect = self.pointer_result
        self.library.voicevox_synthesizer_new.side_effect = self.pointer_result
        self.library.voicevox_voice_model_file_open.side_effect = self.pointer_result
        self.library.voicevox_synthesizer_load_voice_model.return_value = 0
        self.library.voicevox_synthesizer_is_gpu_mode.return_value = True
        self.supported = ctypes.create_string_buffer(b'{"cpu":true,"cuda":true,"dml":false}')
        self.library.voicevox_onnxruntime_create_supported_devices_json.side_effect = self.supported_result
        self.patches = [patch("app.runtime.ctypes.CDLL", return_value=self.library),
                        patch.object(runtime.VoicevoxRuntime, "_configure_library")]
        if os.name == "nt":
            self.patches.append(patch("app.runtime.os.add_dll_directory", return_value=Mock()))
            self.patches.append(patch("app.runtime.ctypes.WinDLL", return_value=Mock()))
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    @staticmethod
    def pointer_result(*args):
        args[-1]._obj.value = 42
        return 0

    def supported_result(self, *args):
        args[-1]._obj.value = ctypes.addressof(self.supported)
        return 0

    def test_gpu_initialization_and_close_release_native_resources_once(self):
        instance = runtime.VoicevoxRuntime(self.directory, 2, "cuda")
        instance.initialize()
        self.assertTrue(instance.is_gpu_mode)
        options = self.library.voicevox_synthesizer_new.call_args.args[2]
        self.assertEqual((options.acceleration_mode, options.cpu_num_threads), (2, 2))
        instance.close()
        instance.close()
        self.library.voicevox_synthesizer_delete.assert_called_once()
        self.library.voicevox_open_jtalk_rc_delete.assert_called_once()

    def test_cpu_mode_never_probes_gpu(self):
        self.library.voicevox_synthesizer_is_gpu_mode.return_value = False
        instance = runtime.VoicevoxRuntime(self.directory)
        instance.initialize()
        self.library.voicevox_onnxruntime_create_supported_devices_json.assert_not_called()
        self.assertEqual(self.library.voicevox_synthesizer_new.call_args.args[2].acceleration_mode, 1)
        instance.close()

    def test_missing_cuda_and_directml_builds_are_rejected(self):
        for devices in ({"cuda": False, "dml": False}, {"cuda": True, "dml": True}):
            self.supported = ctypes.create_string_buffer(json.dumps(devices).encode())
            instance = runtime.VoicevoxRuntime(self.directory, device="cuda")
            with self.assertRaisesRegex(RuntimeError, "CUDA-only"):
                instance.initialize()
            self.assertEqual(instance._dll_directory_handles, [])
        self.library.voicevox_synthesizer_new.assert_not_called()

    def test_cuda_failure_never_retries_with_cpu(self):
        self.library.voicevox_synthesizer_new.side_effect = None
        self.library.voicevox_synthesizer_new.return_value = 4
        instance = runtime.VoicevoxRuntime(self.directory, device="cuda")
        with self.assertRaisesRegex(RuntimeError, "initialize synthesizer"):
            instance.initialize()
        self.library.voicevox_synthesizer_new.assert_called_once()
        self.library.voicevox_open_jtalk_rc_delete.assert_called_once()
        self.assertEqual(instance._dll_directory_handles, [])

    @unittest.skipUnless(os.name == "nt", "Windows cuDNN prerequisite")
    def test_missing_zlib_fails_before_native_initialization(self):
        (self.directory / "zlibwapi.dll").unlink()
        with self.assertRaisesRegex(RuntimeError, "zlibwapi"):
            runtime.VoicevoxRuntime(self.directory, device="cuda").initialize()
        self.library.voicevox_synthesizer_new.assert_not_called()

    def test_model_failure_releases_resources_and_allows_retry(self):
        self.library.voicevox_synthesizer_load_voice_model.side_effect = [8, 0]
        instance = runtime.VoicevoxRuntime(self.directory, device="cuda")
        with self.assertRaisesRegex(RuntimeError, "load voice model"):
            instance.initialize()
        self.library.voicevox_voice_model_file_delete.assert_called_once()
        self.library.voicevox_synthesizer_delete.assert_called_once()
        self.library.voicevox_open_jtalk_rc_delete.assert_called_once()
        instance.initialize()
        self.assertTrue(instance.is_gpu_mode)
        instance.close()

    def test_doctor_is_offline_and_rejects_missing_models(self):
        with patch("app.runtime.ctypes.CDLL", side_effect=AssertionError("must not load")):
            self.assertTrue(runtime.doctor(self.directory)["ready"])
            (self.directory / "0.vvm").unlink()
            with self.assertRaisesRegex(RuntimeError, "models missing"):
                runtime.doctor(self.directory)


@unittest.skipUnless(os.environ.get("CAEMBLE_VOICEVOX_REAL_TEST") == "1", "Opt-in real VOICEVOX synthesis")
class RealVoicevoxTests(unittest.TestCase):
    def test_real_worker_dispatches_speakers_query_and_wav(self):
        async def execute():
            app = create_app()
            context = SlaveContext(session_id="real-smoke", ttl_seconds=300)
            await app.run_initialize(context)
            speakers = await app.dispatch(DataChannelMessage(id="speakers", type="ai.voicevox.speakers", payload={}), context)
            self.assertTrue(speakers.payload["speakers"])
            query = await app.dispatch(DataChannelMessage(id="query", type="ai.voicevox.audio_query",
                payload={"text": "こんにちは。", "speaker": 3}), context)
            return await app.dispatch(DataChannelMessage(id="synthesis", type="ai.voicevox.synthesis",
                payload={"audio_query": query.payload["audio_query"], "speaker": 3}), context)

        try:
            response = asyncio.run(execute())
            self.assertEqual(response.id, "synthesis")
            with wave.open(io.BytesIO(response.attachments[0].data), "rb") as stream:
                self.assertEqual(stream.getsampwidth(), 2)
                self.assertGreater(stream.getnframes(), 2400)
            self.assertEqual(runtime.get_voicevox_runtime().is_gpu_mode, runtime.execution_device() == "cuda")
        finally:
            runtime.close_voicevox_runtime()


if __name__ == "__main__":
    unittest.main()
