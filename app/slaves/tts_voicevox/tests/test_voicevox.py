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
from app.settings import Settings
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

    def test_preload_list_reaches_runtime_and_invalid_lists_are_rejected(self):
        fake = Mock()
        fake.create_audio_query.return_value = {"accent_phrases": []}
        context = SlaveContext(session_id="session", ttl_seconds=60)
        with patch("app.handlers.get_voicevox_runtime", return_value=fake):
            request = DataChannelMessage(id="preload", type="ai.voicevox.audio_query",
                                         payload={"text": "こんにちは", "speaker": 3, "preload_speakers": [3, 4]})
            result = asyncio.run(create_app().dispatch(request, context))
            fake.create_audio_query.assert_called_once_with("こんにちは", 3, [3, 4])
            self.assertEqual(result.id, "preload")
            for ids in ([], [True], [-1], ["3"], [2**32]):
                request.payload["preload_speakers"] = ids
                with self.subTest(ids=ids), self.assertRaises(ValueError):
                    asyncio.run(create_app().dispatch(request, context))
            self.assertEqual(fake.create_audio_query.call_count, 1)

    def test_worker_creates_lightweight_runtime_before_requests(self):
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
                factory.return_value.initialize.assert_not_called()

    def test_getter_is_lazy_and_reuses_runtime(self):
        with patch("app.runtime._runtime", None), patch("app.runtime.execution_context", return_value=None), \
             patch("app.runtime.VoicevoxRuntime") as factory:
            factory.return_value.device = "cpu"
            self.assertIs(runtime.get_voicevox_runtime(), runtime.get_voicevox_runtime())
            factory.assert_called_once()
            factory.return_value.initialize.assert_not_called()


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
        self.metadata = ctypes.create_string_buffer(json.dumps([
            {"name": "A", "speaker_uuid": "a", "version": "1", "styles": [
                {"id": 3, "name": "normal", "type": "talk", "order": 2},
                {"id": 4, "name": "happy", "type": "talk", "order": 1},
            ]},
        ]).encode())
        self.library.voicevox_voice_model_file_create_metas_json.side_effect = lambda model: ctypes.addressof(self.metadata)
        self.library.voicevox_voice_model_file_open.side_effect = self.pointer_result
        self.library.voicevox_synthesizer_load_voice_model.return_value = 0
        self.library.voicevox_synthesizer_is_gpu_mode.return_value = True
        self.supported = ctypes.create_string_buffer(b'{"cpu":true,"cuda":true,"dml":false}')
        self.library.voicevox_onnxruntime_create_supported_devices_json.side_effect = self.supported_result
        self.patches = [patch.dict(os.environ),
                        patch("app.runtime.ctypes.CDLL", return_value=self.library),
                        patch.object(runtime.VoicevoxRuntime, "_configure_library")]
        if os.name == "nt":
            self.patches.append(patch("app.runtime.os.add_dll_directory", return_value=Mock()))
            self.patches.append(patch("app.runtime.ctypes.WinDLL", return_value=Mock()))
        for item in self.patches:
            item.start()
        os.environ.pop("RUST_LOG", None)
        os.environ.pop("VOICEVOX_RUST_LOG", None)

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

    def test_default_log_filter_is_set_before_loading_core(self):
        self.library.voicevox_synthesizer_is_gpu_mode.return_value = False
        configured = Settings(_env_file=None)
        expected = "error,voicevox_core=info,voicevox_core_c_api=info,ort=error"
        self.assertEqual(configured.voicevox_rust_log, expected)

        def load_core(*args):
            self.assertEqual(os.environ.get("RUST_LOG"), expected)
            return self.library

        with patch("app.runtime.settings", configured), patch("app.runtime.ctypes.CDLL", side_effect=load_core):
            instance = runtime.VoicevoxRuntime(self.directory)
            instance.initialize()
            instance.close()

    def test_dotenv_log_filter_reaches_first_native_call(self):
        self.library.voicevox_synthesizer_is_gpu_mode.return_value = False
        expected = "error,voicevox_core=info,voicevox_core_c_api=info,ort=warn"
        dotenv = self.directory / ".env"
        dotenv.write_text(f"VOICEVOX_RUST_LOG={expected}\n", encoding="utf-8")
        configured = Settings(_env_file=dotenv)
        self.assertEqual(configured.voicevox_rust_log, expected)
        filename = self.library.voicevox_get_onnxruntime_lib_versioned_filename.return_value

        def first_native_call():
            self.assertEqual(os.environ.get("RUST_LOG"), expected)
            return filename

        self.library.voicevox_get_onnxruntime_lib_versioned_filename.side_effect = first_native_call
        with patch("app.runtime.settings", configured):
            instance = runtime.VoicevoxRuntime(self.directory)
            instance.initialize()
            instance.close()

    def test_existing_rust_log_takes_precedence(self):
        self.library.voicevox_synthesizer_is_gpu_mode.return_value = False
        for explicit in ("ort=debug", ""):
            with self.subTest(value=explicit), patch.dict(os.environ, {"RUST_LOG": explicit}), \
                 patch("app.runtime.settings", Settings(_env_file=None)):
                instance = runtime.VoicevoxRuntime(self.directory)
                instance.initialize()
                self.assertEqual(os.environ["RUST_LOG"], explicit)
                instance.close()

    def test_synthesis_error_is_not_hidden_by_log_filter(self):
        self.library.voicevox_synthesizer_is_gpu_mode.return_value = False
        self.library.voicevox_make_default_synthesis_options.return_value = runtime.VoicevoxSynthesisOptions()
        self.library.voicevox_synthesizer_synthesis.return_value = 4
        with patch("app.runtime.settings", Settings(_env_file=None)):
            instance = runtime.VoicevoxRuntime(self.directory)
            instance.initialize()
            try:
                with self.assertRaisesRegex(RuntimeError, "synthesize audio.*fixture native failure"):
                    instance.synthesis({}, 3)
            finally:
                instance.close()

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
            instance.initialize([3])
        self.assertEqual(self.library.voicevox_voice_model_file_delete.call_count, 2)
        self.library.voicevox_synthesizer_delete.assert_called_once()
        self.library.voicevox_open_jtalk_rc_delete.assert_called_once()
        self.assertFalse(instance._loaded_models)
        instance.initialize([3])
        self.assertTrue(instance.is_gpu_mode)
        instance.close()

    def test_metadata_merges_styles_and_never_initializes_inference(self):
        (self.directory / "1.vvm").write_bytes(b"fixture")
        extra = ctypes.create_string_buffer(json.dumps([
            {"name": "B", "speaker_uuid": "b", "order": 0, "styles": [{"id": 7, "name": "normal"}]},
            {"name": "ignored", "speaker_uuid": "a", "version": "2", "styles": [{"id": 5, "name": "other"}]},
        ]).encode())
        self.library.voicevox_voice_model_file_create_metas_json.side_effect = [
            ctypes.addressof(self.metadata), ctypes.addressof(extra),
        ]
        instance = runtime.VoicevoxRuntime(self.directory, device="cuda")
        result = instance.speakers()
        self.assertEqual([speaker["name"] for speaker in result], ["B", "A"])
        self.assertEqual(result[1]["version"], "1")
        self.assertEqual([style["id"] for style in result[1]["styles"]], [4, 3, 5])
        self.library.voicevox_onnxruntime_load_once.assert_not_called()
        self.library.voicevox_open_jtalk_rc_new.assert_not_called()
        self.library.voicevox_synthesizer_new.assert_not_called()
        self.library.voicevox_synthesizer_load_voice_model.assert_not_called()
        result.clear()
        self.assertEqual(len(instance.speakers()), 2)
        self.assertEqual(self.library.voicevox_voice_model_file_delete.call_count, 2)
        instance.close()

    def test_selected_styles_share_model_and_are_loaded_once(self):
        instance = runtime.VoicevoxRuntime(self.directory, device="cuda")
        instance.initialize([3, 4, 3])
        instance.initialize([4])
        self.library.voicevox_synthesizer_load_voice_model.assert_called_once()
        self.assertEqual(instance._loaded_models, {self.directory / "0.vvm"})
        instance.close()

    def test_unknown_empty_and_invalid_ids_fail_before_inference(self):
        instance = runtime.VoicevoxRuntime(self.directory)
        for ids in ([], [999], [-1], [True], [2**32]):
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                instance.initialize(ids)
        with self.assertRaisesRegex(ValueError, "included"):
            instance.create_audio_query("text", 3, [4])
        self.library.voicevox_synthesizer_new.assert_not_called()
        instance.close()

    def test_partial_multi_model_failure_clears_loaded_state(self):
        (self.directory / "1.vvm").write_bytes(b"fixture")
        extra = ctypes.create_string_buffer(b'[{"name":"B","speaker_uuid":"b","styles":[{"id":5,"name":"normal"}]}]')
        self.library.voicevox_voice_model_file_create_metas_json.side_effect = [
            ctypes.addressof(self.metadata), ctypes.addressof(extra),
            ctypes.addressof(self.metadata), ctypes.addressof(extra),
        ]
        self.library.voicevox_synthesizer_load_voice_model.side_effect = [0, 8, 0, 0]
        instance = runtime.VoicevoxRuntime(self.directory, device="cuda")
        with self.assertRaisesRegex(RuntimeError, "load voice model"):
            instance.initialize([3, 5])
        self.assertFalse(instance._loaded_models)
        self.library.voicevox_synthesizer_delete.assert_called_once()
        instance.initialize([3, 5])
        self.assertEqual(len(instance._loaded_models), 2)
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
            self.assertFalse(runtime.get_voicevox_runtime()._synthesizer.value)
            query = await app.dispatch(DataChannelMessage(id="query", type="ai.voicevox.audio_query",
                payload={"text": "こんにちは。", "speaker": 3, "preload_speakers": [3, 4]}), context)
            self.assertEqual(len(runtime.get_voicevox_runtime()._loaded_models), 1)
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
