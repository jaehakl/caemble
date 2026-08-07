from __future__ import annotations

import ctypes
import json
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from app.voicevox.runtime import (
    VoicevoxInitializeOptions,
    VoicevoxLoadOnnxruntimeOptions,
    VoicevoxRuntime,
    VoicevoxSynthesisOptions,
)


class FakeFunction:
    def __init__(self, implementation):
        self.implementation = implementation
        self.argtypes = None
        self.restype = None

    def __call__(self, *args):
        return self.implementation(*args)


class FakeVoicevoxLibrary:
    def __init__(self, onnx_filename: str, version: str = "0.16.4") -> None:
        self.buffers = []
        self.json_frees = []
        self.wav_frees = []
        self.calls = []
        self.voicevox_get_version = FakeFunction(lambda: version.encode("utf-8"))
        self.voicevox_get_onnxruntime_lib_versioned_filename = FakeFunction(
            lambda: onnx_filename.encode("utf-8")
        )
        self.voicevox_make_default_load_onnxruntime_options = FakeFunction(
            lambda: VoicevoxLoadOnnxruntimeOptions()
        )
        self.voicevox_onnxruntime_load_once = FakeFunction(
            lambda options, output: self._set_output("load_onnx", output, 101, options.filename)
        )
        self.voicevox_open_jtalk_rc_new = FakeFunction(
            lambda path, output: self._set_output("open_jtalk", output, 102, path)
        )
        self.voicevox_open_jtalk_rc_delete = FakeFunction(
            lambda pointer: self.calls.append(("delete_open_jtalk", self._value(pointer)))
        )
        self.voicevox_make_default_initialize_options = FakeFunction(
            lambda: VoicevoxInitializeOptions()
        )
        self.voicevox_synthesizer_new = FakeFunction(self._new_synthesizer)
        self.voicevox_synthesizer_delete = FakeFunction(
            lambda pointer: self.calls.append(("delete_synthesizer", self._value(pointer)))
        )
        self.voicevox_voice_model_file_open = FakeFunction(
            lambda path, output: self._set_output("open_model", output, 104, path)
        )
        self.voicevox_voice_model_file_delete = FakeFunction(
            lambda pointer: self.calls.append(("delete_model", self._value(pointer)))
        )
        self.voicevox_synthesizer_load_voice_model = FakeFunction(
            lambda synthesizer, model: self._record_ok(
                "load_model", self._value(synthesizer), self._value(model)
            )
        )
        self.voicevox_synthesizer_create_metas_json = FakeFunction(
            lambda synthesizer: self._json_pointer(
                [{"name": "Speaker", "speaker_uuid": "speaker-1", "styles": [{"id": 2, "name": "Normal"}]}]
            )
        )
        self.voicevox_synthesizer_create_audio_query = FakeFunction(self._create_audio_query)
        self.voicevox_audio_query_validate = FakeFunction(
            lambda query: self._record_ok("validate", query)
        )
        self.voicevox_make_default_synthesis_options = FakeFunction(
            lambda: VoicevoxSynthesisOptions(True)
        )
        self.voicevox_synthesizer_synthesis = FakeFunction(self._synthesis)
        self.voicevox_json_free = FakeFunction(lambda pointer: self.json_frees.append(self._value(pointer)))
        self.voicevox_wav_free = FakeFunction(lambda pointer: self.wav_frees.append(self._value(pointer)))
        self.voicevox_error_result_to_message = FakeFunction(lambda result: b"fake error")

    @staticmethod
    def _value(pointer) -> int | None:
        return pointer.value if isinstance(pointer, ctypes.c_void_p) else pointer

    def _set_output(self, name, output, value, *details):
        ctypes.cast(output, ctypes.POINTER(ctypes.c_void_p))[0] = value
        self.calls.append((name, *details))
        return 0

    def _record_ok(self, name, *details):
        self.calls.append((name, *details))
        return 0

    def _new_synthesizer(self, onnxruntime, open_jtalk, options, output):
        self.calls.append(
            (
                "new_synthesizer",
                self._value(onnxruntime),
                self._value(open_jtalk),
                options.acceleration_mode,
                options.cpu_num_threads,
            )
        )
        ctypes.cast(output, ctypes.POINTER(ctypes.c_void_p))[0] = 103
        return 0

    def _json_pointer(self, value) -> int:
        buffer = ctypes.create_string_buffer(json.dumps(value, ensure_ascii=False).encode("utf-8"))
        self.buffers.append(buffer)
        return ctypes.addressof(buffer)

    def _create_audio_query(self, synthesizer, text, speaker, output):
        self.calls.append(("audio_query", text, speaker))
        ctypes.cast(output, ctypes.POINTER(ctypes.c_void_p))[0] = self._json_pointer(
            {"accentPhrases": [], "speedScale": 1.0}
        )
        return 0

    def _synthesis(self, synthesizer, query, speaker, options, output_length, output):
        self.calls.append(("synthesis", query, speaker, options.enable_interrogative_upspeak))
        buffer = ctypes.create_string_buffer(b"RIFF\x04\x00\x00\x00WAVE")
        self.buffers.append(buffer)
        ctypes.cast(output_length, ctypes.POINTER(ctypes.c_size_t))[0] = len(buffer.raw) - 1
        ctypes.cast(output, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.addressof(buffer)
        return 0


class VoicevoxRuntimeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.runtime_dir = Path(self.temp_dir.name)
        self.core_filename = "voicevox_core.dll" if os.name == "nt" else "libvoicevox_core.so"
        self.onnx_filename = "onnxruntime.dll" if os.name == "nt" else "libonnxruntime.so.1"
        for relative_path in (
            Path("c_api") / self.core_filename,
            Path("onnxruntime") / self.onnx_filename,
            Path("dict") / "open_jtalk_dic_utf_8-1.11" / "sys.dic",
            Path("models") / "vvms" / "0.vvm",
        ):
            path = self.runtime_dir / relative_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_runtime_initializes_once_and_frees_json_and_wav(self) -> None:
        library = FakeVoicevoxLibrary(self.onnx_filename)
        runtime = VoicevoxRuntime(self.runtime_dir, cpu_num_threads=3)

        with patch("app.voicevox.runtime.ctypes.CDLL", return_value=library) as load_library:
            speakers = runtime.speakers()
            query = runtime.create_audio_query("こんにちは", 2)
            query["speedScale"] = 1.25
            wav = runtime.synthesis(query, 2, False)
            runtime.close()

        self.assertEqual(speakers[0]["speaker_uuid"], "speaker-1")
        self.assertEqual(query["speedScale"], 1.25)
        self.assertTrue(wav.startswith(b"RIFF"))
        self.assertEqual(load_library.call_count, 1)
        self.assertEqual(sum(call[0] == "load_onnx" for call in library.calls), 1)
        self.assertEqual(sum(call[0] == "load_model" for call in library.calls), 1)
        self.assertIn(("load_model", 103, 104), library.calls)
        self.assertEqual(len(library.json_frees), 2)
        self.assertEqual(len(library.wav_frees), 1)
        self.assertIn(("audio_query", "こんにちは".encode("utf-8"), 2), library.calls)
        synthesis_call = next(call for call in library.calls if call[0] == "synthesis")
        self.assertEqual(json.loads(synthesis_call[1].decode("utf-8"))["speedScale"], 1.25)
        self.assertFalse(synthesis_call[3])
        initialize_call = next(call for call in library.calls if call[0] == "new_synthesizer")
        self.assertEqual(initialize_call[3:], (1, 3))
        self.assertIn(("delete_synthesizer", 103), library.calls)
        self.assertIn(("delete_open_jtalk", 102), library.calls)

    def test_runtime_converts_core_error_message(self) -> None:
        library = FakeVoicevoxLibrary(self.onnx_filename)
        library.voicevox_audio_query_validate.implementation = lambda query: 14
        runtime = VoicevoxRuntime(self.runtime_dir)

        with patch("app.voicevox.runtime.ctypes.CDLL", return_value=library):
            with self.assertRaisesRegex(RuntimeError, "validate audio query: fake error"):
                runtime.synthesis({"accentPhrases": []}, 2)
            runtime.close()

        self.assertEqual(library.wav_frees, [])

    def test_runtime_rejects_mismatched_core_version_before_initialization(self) -> None:
        library = FakeVoicevoxLibrary(self.onnx_filename, version="0.16.3")
        runtime = VoicevoxRuntime(self.runtime_dir)

        with patch("app.voicevox.runtime.ctypes.CDLL", return_value=library):
            with self.assertRaisesRegex(
                RuntimeError,
                "Unsupported VOICEVOX Core version: expected 0.16.4, got 0.16.3",
            ):
                runtime.speakers()

        self.assertFalse(any(call[0] == "load_onnx" for call in library.calls))

    def test_concurrent_first_calls_share_one_initialization(self) -> None:
        library = FakeVoicevoxLibrary(self.onnx_filename)
        runtime = VoicevoxRuntime(self.runtime_dir)

        with patch("app.voicevox.runtime.ctypes.CDLL", return_value=library) as load_library:
            with ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(lambda _: runtime.speakers(), range(2)))
            runtime.close()

        self.assertEqual([result[0]["speaker_uuid"] for result in results], ["speaker-1", "speaker-1"])
        self.assertEqual(load_library.call_count, 1)
        self.assertEqual(sum(call[0] == "load_model" for call in library.calls), 1)


if __name__ == "__main__":
    unittest.main()
