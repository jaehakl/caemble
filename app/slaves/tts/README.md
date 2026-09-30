# English TTS worker

An independent Python 3.12 CPU environment runs Kokoro **model v1.0** with the
Kokoro/Misaki Python packages pinned to 0.9.4. It does not change the AI worker's
Torch, CUDA, LLM or SDXL dependencies. The launcher discovers `manifest.json`.

From `app/slaves/tts`, prepare explicitly before starting/restarting the launcher:

```powershell
poetry env use 3.12
poetry install
poetry run python -m app prepare
poetry run python -m app doctor
poetry run python -m app smoke
poetry run python -m unittest discover -s tests -v
```

`prepare` downloads a pinned `hexgrad/Kokoro-82M` revision and the official
`en_core_web_sm` 3.8.0 model. Models are stored under `.models/kokoro-v1.0` by
default. `CAEMBLE_TTS_MODEL_DIR` can select an absolute pre-provisioned directory.
The preparation manifest stores file sizes and SHA-256 checksums. `doctor` is
offline and fast; initialization also verifies the full checksums and starts the
real CPU pipeline. Missing models fail with a preparation instruction; no request
downloads assets. The manifest intentionally does not auto-run `prepare`.

`smoke` creates `.data/kokoro-smoke.wav` with the real model. Play this file to
check voice quality. To include actual synthesis in the automated tests, set
`CAEMBLE_TTS_REAL_TEST=1` before running unittest.

Use a separate GPStation session with `slaveAppId: "tts"`,
`handlerType: "ai.kokoro.synthesis"`, and CPU resources (`gpuCount: 0`). Do not
send this handler to the existing `ai` session. Recommended launcher resource
configuration in `.data/resources.toml`:

```toml
[defaults.tts]
cpu_cores = 4
gpu_count = 0
```

Request payload:

```json
{"text":"I used to get up early.","voice":"af_heart","speed":1.0}
```

Only the prepared US voice `af_heart` is accepted. Speed is 0.5–2.0, and text is
limited to 2,000 Unicode code points. The response type is
`ai.kokoro.synthesis.result`, with one `audio-1` WAV attachment (mono PCM16,
24 kHz). The payload contains `attachment_id`, `mime_type`, `size`, `model`,
`model_revision`, `voice`, `speed`, `language`, `sample_rate`, `duration_seconds`,
`input_hash` (SHA-256 of exact UTF-8 text), `audio_sha256`, `preprocessing_version`
(`kokoro-0.9.4-misaki-0.9.4-v1`), and preprocessing info.
Neo must bind this result to the matching example revision and require listening
approval before publication.

The SDK owns worker process lifetime and cancellation. Synthesis is serialized
inside a worker; closing/canceling its GPStation job lets the launcher reap the
isolated process without affecting the Japanese or image worker.
