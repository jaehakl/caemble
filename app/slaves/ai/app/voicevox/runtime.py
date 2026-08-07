from __future__ import annotations

import atexit
import ctypes
import json
import os
import threading
from pathlib import Path
from typing import Any

from app.settings import settings


VOICEVOX_RESULT_OK = 0
VOICEVOX_ACCELERATION_MODE_CPU = 1
VOICEVOX_CORE_VERSION = "0.16.4"


class VoicevoxLoadOnnxruntimeOptions(ctypes.Structure):
    _fields_ = [("filename", ctypes.c_char_p)]


class VoicevoxInitializeOptions(ctypes.Structure):
    _fields_ = [
        ("acceleration_mode", ctypes.c_int32),
        ("cpu_num_threads", ctypes.c_uint16),
    ]


class VoicevoxSynthesisOptions(ctypes.Structure):
    _fields_ = [("enable_interrogative_upspeak", ctypes.c_bool)]


class VoicevoxRuntime:
    def __init__(self, runtime_dir: Path, cpu_num_threads: int = 0) -> None:
        self.runtime_dir = runtime_dir
        self.cpu_num_threads = cpu_num_threads
        self._lock = threading.RLock()
        self._lib: Any | None = None
        self._open_jtalk = ctypes.c_void_p()
        self._synthesizer = ctypes.c_void_p()
        self._dll_directory_handles: list[Any] = []

    def speakers(self) -> list[dict[str, Any]]:
        with self._lock:
            self._ensure_initialized_locked()
            pointer = self._lib.voicevox_synthesizer_create_metas_json(self._synthesizer)
            if not pointer:
                raise RuntimeError("VOICEVOX Core returned an empty speaker metadata pointer")
            metadata = self._read_json_pointer(pointer)
            if not isinstance(metadata, list):
                raise RuntimeError("VOICEVOX Core returned invalid speaker metadata")
            return metadata

    def create_audio_query(self, text: str, speaker: int) -> dict[str, Any]:
        with self._lock:
            self._ensure_initialized_locked()
            output = ctypes.c_void_p()
            result = self._lib.voicevox_synthesizer_create_audio_query(
                self._synthesizer,
                text.encode("utf-8"),
                speaker,
                ctypes.byref(output),
            )
            self._raise_for_result(result, "create audio query")
            query = self._read_json_pointer(output.value)
            if not isinstance(query, dict):
                raise RuntimeError("VOICEVOX Core returned an invalid AudioQuery")
            return query

    def synthesis(
        self,
        audio_query: dict[str, Any],
        speaker: int,
        enable_interrogative_upspeak: bool | None = None,
    ) -> bytes:
        query_json = json.dumps(
            audio_query,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
        with self._lock:
            self._ensure_initialized_locked()
            self._raise_for_result(
                self._lib.voicevox_audio_query_validate(query_json),
                "validate audio query",
            )
            options = self._lib.voicevox_make_default_synthesis_options()
            if enable_interrogative_upspeak is not None:
                options.enable_interrogative_upspeak = enable_interrogative_upspeak
            output_length = ctypes.c_size_t()
            output = ctypes.c_void_p()
            result = self._lib.voicevox_synthesizer_synthesis(
                self._synthesizer,
                query_json,
                speaker,
                options,
                ctypes.byref(output_length),
                ctypes.byref(output),
            )
            self._raise_for_result(result, "synthesize audio")
            if not output.value:
                raise RuntimeError("VOICEVOX Core returned an empty WAV pointer")
            try:
                return ctypes.string_at(output.value, output_length.value)
            finally:
                self._lib.voicevox_wav_free(output.value)

    def close(self) -> None:
        with self._lock:
            if self._lib is not None and self._synthesizer.value:
                self._lib.voicevox_synthesizer_delete(self._synthesizer)
                self._synthesizer = ctypes.c_void_p()
            if self._lib is not None and self._open_jtalk.value:
                self._lib.voicevox_open_jtalk_rc_delete(self._open_jtalk)
                self._open_jtalk = ctypes.c_void_p()

    def _ensure_initialized_locked(self) -> None:
        if self._synthesizer.value:
            return
        if not self.runtime_dir.is_dir():
            raise RuntimeError(
                "VOICEVOX runtime is not installed. Run "
                "`poetry run python scripts/install_voicevox.py` in app/slaves/ai."
            )

        core_library = self._find_one("voicevox_core.dll" if os.name == "nt" else "libvoicevox_core.so")
        if os.name == "nt":
            for directory in sorted({path.parent for path in self.runtime_dir.rglob("*.dll")}):
                self._dll_directory_handles.append(os.add_dll_directory(str(directory)))

        library = ctypes.CDLL(str(core_library))
        self._validate_library_version(library)
        self._configure_library(library)

        onnx_filename = library.voicevox_get_onnxruntime_lib_versioned_filename().decode("utf-8")
        onnx_library = self._find_one(onnx_filename)
        load_onnx_options = library.voicevox_make_default_load_onnxruntime_options()
        load_onnx_options.filename = str(onnx_library).encode("utf-8")
        onnxruntime = ctypes.c_void_p()
        self._raise_for_result_with_library(
            library,
            library.voicevox_onnxruntime_load_once(load_onnx_options, ctypes.byref(onnxruntime)),
            "load ONNX Runtime",
        )

        dictionary = self._find_one("sys.dic").parent
        open_jtalk = ctypes.c_void_p()
        self._raise_for_result_with_library(
            library,
            library.voicevox_open_jtalk_rc_new(str(dictionary).encode("utf-8"), ctypes.byref(open_jtalk)),
            "initialize Open JTalk",
        )

        synthesizer = ctypes.c_void_p()
        try:
            initialize_options = library.voicevox_make_default_initialize_options()
            initialize_options.acceleration_mode = VOICEVOX_ACCELERATION_MODE_CPU
            initialize_options.cpu_num_threads = self.cpu_num_threads
            self._raise_for_result_with_library(
                library,
                library.voicevox_synthesizer_new(
                    onnxruntime,
                    open_jtalk,
                    initialize_options,
                    ctypes.byref(synthesizer),
                ),
                "initialize synthesizer",
            )

            model_files = sorted(self.runtime_dir.rglob("*.vvm"))
            if not model_files:
                raise RuntimeError(f"VOICEVOX voice models were not found under {self.runtime_dir}")
            for model_path in model_files:
                model = ctypes.c_void_p()
                self._raise_for_result_with_library(
                    library,
                    library.voicevox_voice_model_file_open(str(model_path).encode("utf-8"), ctypes.byref(model)),
                    f"open voice model {model_path.name}",
                )
                try:
                    self._raise_for_result_with_library(
                        library,
                        library.voicevox_synthesizer_load_voice_model(synthesizer, model),
                        f"load voice model {model_path.name}",
                    )
                finally:
                    library.voicevox_voice_model_file_delete(model)
        except Exception:
            if synthesizer.value:
                library.voicevox_synthesizer_delete(synthesizer)
            library.voicevox_open_jtalk_rc_delete(open_jtalk)
            raise

        self._lib = library
        self._open_jtalk = open_jtalk
        self._synthesizer = synthesizer

    def _find_one(self, filename: str) -> Path:
        matches = [path for path in self.runtime_dir.rglob(filename) if path.is_file()]
        if len(matches) != 1:
            raise RuntimeError(
                f"Expected exactly one {filename} under {self.runtime_dir}, found {len(matches)}"
            )
        return matches[0]

    def _read_json_pointer(self, pointer: int | None) -> Any:
        if not pointer:
            raise RuntimeError("VOICEVOX Core returned an empty JSON pointer")
        try:
            return json.loads(ctypes.string_at(pointer).decode("utf-8"))
        finally:
            self._lib.voicevox_json_free(pointer)

    def _raise_for_result(self, result: int, operation: str) -> None:
        self._raise_for_result_with_library(self._lib, result, operation)

    @staticmethod
    def _raise_for_result_with_library(library: Any, result: int, operation: str) -> None:
        if result == VOICEVOX_RESULT_OK:
            return
        message = library.voicevox_error_result_to_message(result)
        detail = message.decode("utf-8") if message else f"result code {result}"
        raise RuntimeError(f"VOICEVOX failed to {operation}: {detail}")

    @staticmethod
    def _validate_library_version(library: Any) -> None:
        library.voicevox_get_version.argtypes = []
        library.voicevox_get_version.restype = ctypes.c_char_p
        raw_version = library.voicevox_get_version()
        actual_version = raw_version.decode("utf-8", errors="replace") if raw_version else "unknown"
        if actual_version != VOICEVOX_CORE_VERSION:
            raise RuntimeError(
                "Unsupported VOICEVOX Core version: "
                f"expected {VOICEVOX_CORE_VERSION}, got {actual_version}"
            )

    @staticmethod
    def _configure_library(library: Any) -> None:
        library.voicevox_get_onnxruntime_lib_versioned_filename.argtypes = []
        library.voicevox_get_onnxruntime_lib_versioned_filename.restype = ctypes.c_char_p
        library.voicevox_make_default_load_onnxruntime_options.argtypes = []
        library.voicevox_make_default_load_onnxruntime_options.restype = VoicevoxLoadOnnxruntimeOptions
        library.voicevox_onnxruntime_load_once.argtypes = [
            VoicevoxLoadOnnxruntimeOptions,
            ctypes.POINTER(ctypes.c_void_p),
        ]
        library.voicevox_onnxruntime_load_once.restype = ctypes.c_int32
        library.voicevox_open_jtalk_rc_new.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
        library.voicevox_open_jtalk_rc_new.restype = ctypes.c_int32
        library.voicevox_open_jtalk_rc_delete.argtypes = [ctypes.c_void_p]
        library.voicevox_open_jtalk_rc_delete.restype = None
        library.voicevox_make_default_initialize_options.argtypes = []
        library.voicevox_make_default_initialize_options.restype = VoicevoxInitializeOptions
        library.voicevox_synthesizer_new.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            VoicevoxInitializeOptions,
            ctypes.POINTER(ctypes.c_void_p),
        ]
        library.voicevox_synthesizer_new.restype = ctypes.c_int32
        library.voicevox_synthesizer_delete.argtypes = [ctypes.c_void_p]
        library.voicevox_synthesizer_delete.restype = None
        library.voicevox_voice_model_file_open.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
        library.voicevox_voice_model_file_open.restype = ctypes.c_int32
        library.voicevox_voice_model_file_delete.argtypes = [ctypes.c_void_p]
        library.voicevox_voice_model_file_delete.restype = None
        library.voicevox_synthesizer_load_voice_model.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
        ]
        library.voicevox_synthesizer_load_voice_model.restype = ctypes.c_int32
        library.voicevox_synthesizer_create_metas_json.argtypes = [ctypes.c_void_p]
        library.voicevox_synthesizer_create_metas_json.restype = ctypes.c_void_p
        library.voicevox_synthesizer_create_audio_query.argtypes = [
            ctypes.c_void_p,
            ctypes.c_char_p,
            ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_void_p),
        ]
        library.voicevox_synthesizer_create_audio_query.restype = ctypes.c_int32
        library.voicevox_audio_query_validate.argtypes = [ctypes.c_char_p]
        library.voicevox_audio_query_validate.restype = ctypes.c_int32
        library.voicevox_make_default_synthesis_options.argtypes = []
        library.voicevox_make_default_synthesis_options.restype = VoicevoxSynthesisOptions
        library.voicevox_synthesizer_synthesis.argtypes = [
            ctypes.c_void_p,
            ctypes.c_char_p,
            ctypes.c_uint32,
            VoicevoxSynthesisOptions,
            ctypes.POINTER(ctypes.c_size_t),
            ctypes.POINTER(ctypes.c_void_p),
        ]
        library.voicevox_synthesizer_synthesis.restype = ctypes.c_int32
        library.voicevox_json_free.argtypes = [ctypes.c_void_p]
        library.voicevox_json_free.restype = None
        library.voicevox_wav_free.argtypes = [ctypes.c_void_p]
        library.voicevox_wav_free.restype = None
        library.voicevox_error_result_to_message.argtypes = [ctypes.c_int32]
        library.voicevox_error_result_to_message.restype = ctypes.c_char_p


_runtime: VoicevoxRuntime | None = None
_runtime_lock = threading.Lock()


def get_voicevox_runtime() -> VoicevoxRuntime:
    global _runtime
    with _runtime_lock:
        if _runtime is None:
            _runtime = VoicevoxRuntime(
                settings.resolve_ai_path(settings.voicevox_runtime_dir),
                settings.voicevox_cpu_num_threads,
            )
        return _runtime


def close_voicevox_runtime() -> None:
    global _runtime
    with _runtime_lock:
        if _runtime is not None:
            _runtime.close()
            _runtime = None


atexit.register(close_voicevox_runtime)
