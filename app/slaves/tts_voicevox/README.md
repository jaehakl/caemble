# Japanese TTS worker

Independent VOICEVOX Core **0.16.4**, using the C API through ctypes and pinned
VOICEVOX ONNX Runtime **1.17.3**. No Torch, Kokoro or AI model dependencies.

From this directory:

```powershell
poetry install
poetry run python scripts/install_voicevox.py --device cuda
poetry run python -m app doctor
poetry run python -m app smoke --device cpu
poetry run python -m app smoke --device cuda
poetry run python -m unittest discover -s tests -v
```

The installer defaults to CUDA on Windows/Linux x64. `--device cpu` installs a
CPU-only runtime. It displays the official model/runtime terms, checks the pinned
downloader SHA-256 and installs additional libraries 0.2.1 and talk models 0.16.4.
Windows CUDA also installs the checksum-pinned `zlibwapi.dll` prerequisite linked
by [NVIDIA's cuDNN guide](https://docs.nvidia.com/deeplearning/cudnn/archives/cudnn-893/install-guide/index.html#install-zlib-windows)
inside the runtime directory. No system PATH changes are needed. Linux requires
the system zlib runtime (`zlib1g` on Debian/Ubuntu).
DirectML and multiple GPU allocations are unsupported. CUDA jobs require the
CUDA-only ONNX Runtime build: a missing provider or failed GPU initialization is
an error, never a CPU/DirectML fallback. CUDA uses logical device 0 within the
Launcher's `CUDA_VISIBLE_DEVICES` allocation.

`doctor` is an offline file check, not a GPU execution test; it is used by Launcher
readiness. Initialization loads models and tests the selected device. No startup
or synthesis request downloads files. Each process owns one serialized runtime;
closing/canceling a job lets the SDK/Launcher reap it and release the allocation.

Copy `env.example` to `.env` to configure `VOICEVOX_RUNTIME_DIR` (relative to this
project, or absolute) and `VOICEVOX_CPU_NUM_THREADS` (0 means automatic, capped by
the job's CPU allocation). Native libraries are loaded from that runtime tree.
Linux entrypoints establish its shared-library search paths before loading Core.

Jobs use `slaveAppId: "tts_voicevox"`. Zero allocated GPUs selects CPU; one selects
CUDA. Standalone smoke defaults to CPU and accepts `--device cuda`. Explicit smoke
device selection cannot override a managed job's allocation.

| Handler | Request payload | Result payload |
| --- | --- | --- |
| `ai.voicevox.speakers` | `{}` | `{"speakers": [...]}` |
| `ai.voicevox.audio_query` | `{"text": "こんにちは", "speaker": 3}` | `{"audio_query": {...}}` |
| `ai.voicevox.synthesis` | `{"audio_query": {...}, "speaker": 3, "enable_interrogative_upspeak": true}` | `{"attachment_id": "audio-1", "mime_type": "audio/wav", "size": ...}` |

Results preserve the request ID and append `.result` to its handler type.
Synthesis returns one `audio-1` attachment named `voicevox.wav`. The upspeak option
is optional. These contracts are unchanged from the former AI handlers.

Smoke uses speaker 3 (VOICEVOX:ずんだもん), creates `.data/voicevox-{device}-smoke.wav`,
checks PCM16/non-silent output and prints initialization, AudioQuery, and three
post-warmup synthesis times. Use `--speaker`, `--text`, or `--output` to customize.
Run CPU and CUDA in separate processes with identical inputs for comparison.
Set `CAEMBLE_VOICEVOX_REAL_TEST=1` to include actual worker initialization and all
three handler calls in unittest. It follows the SDK execution allocation (CPU
when unmanaged), so run CUDA contract checks in a GPU-allocated process.
Generated default samples are credited **VOICEVOX:ずんだもん**; follow the installed
voice's terms when sharing audio. Automated checks do not replace listening.

See [worker operations](../../../docs/operations/workers.md#japanese-tts-configuration)
for migration of local assets/settings and external callers.
