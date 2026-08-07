# Caemble v1 Slave Executables

`app/slaves/` contains Caemble's independent slave executable projects. The built-in `ai` app exposes LLM, streaming chat, SDXL image generation, text embedding, CLIP, WD14, and VOICEVOX handlers through the persistent worker/job runtime. The built-in `cae` app exposes Caemble solver manifests and the CAE simulation protocol.

## Install

```powershell
cd app/slaves/ai
poetry install
```

Copy `app/slaves/ai/models.example.toml` to `models.toml`, then register at least one LLM, SDXL, and embedding model and a `default_model` for each family. The real file is local, ignored by git, and is not replaced by the example at runtime. Relative paths are resolved from `app/slaves/ai`, and a successful catalog load is cached until the worker restarts.

- `[llm]` requires the shared GPU/context, batch, attention, and generation values shown in the example. Each model requires only `name` and `path`; optional fields override the shared values. Optional `n_gpu_layers` and `n_threads` may be set at either level.
- `[sdxl]` requires the shared ControlNet IDs and image/control generation defaults. Each model requires only `name` and `path`; optional fields, including `clip_skip`, override the shared values.
- Embedding entries contain either a local `path` or a Hugging Face `model_name`. `revision` is optional; when provided it must be an immutable 40-character commit SHA. With `local_files_only=true`, an omitted revision requires the model's default revision to already exist in the local cache.

See `models.example.toml` for the complete schema. AI remains a full bundle: all three model families and their Python dependencies must be configured even when a deployment uses only a subset of handlers. `.env` is used only for optional VOICEVOX runtime settings.

## Run

```powershell
cd app/launcher
poetry run launcher
```

The launcher discovers `../slaves/*/manifest.json` and advertises only executables
whose project-local `.venv` contains a runnable Python interpreter. Install a
slave before starting or reconnecting the launcher when that machine should
accept jobs for it.

Manifest files require `id`, `name`, and `module`. They may also set `startup_timeout_seconds` when an executable needs more time before it can emit the SDK `worker.ready` frame. The launcher advertises that value to the server and uses it for worker startup waits.

`ai/` sets `startup_timeout_seconds` to `300` because it pre-imports the LLM, SDXL, and embedding libraries during `initialize`. This does not preload model weights, but it can still take longer than the default lightweight worker timeout.

## AI Handlers

`ai` supports these job handler types:

- `ai.llm.models`, `ai.sdxl.models`, `ai.embeddings.models`: return `default_model` and ordered model details without local filesystem paths.
- `ai.llm`: payload `{"model":"main-llm", "system_prompt":"...", "prompt":"...", "max_tokens":512, "temperature":0.5, "think":true, "thinking_effort":"low", "response_format":"text"}` returns `{"model":"main-llm", "answer":"..."}`.
- `ai.chat`: accepts the same generation options as `ai.llm`; the first call requires `system_prompt` and may select an LLM with `model`. Follow-up calls in the same open job session require only `prompt`. Results include the selected `model` and stream only final-answer text through `ai.chat.delta` events. Reasoning is discarded before events, responses, and retained message history. The legacy `enable_thinking` input remains an alias for `think`.
- `ai.embeddings`: payload `{"model":"local-embedding", "text":"..."}` returns `{"model":"local-embedding", "embedding":[...], "dimensions":123}`.
- `ai.embeddings.batch`: payload `{"model":"local-embedding", "texts":["...", "..."]}` returns ordered `embeddings`, `dimensions`, and `count` in one model call.
- `ai.clip.image`: payload `{}` plus one PNG, JPEG, or WebP request attachment with ID `image` returns the fixed OpenAI CLIP ViT-L/14 model name, a normalized 768-dimensional `embedding`, and `dimensions`.
- `ai.clip.text`: payload `{"text":"..."}` returns a normalized 768-dimensional embedding from the same CLIP model. Input is truncated to CLIP's 77-token limit.
- `ai.wd14.tags`: payload `{}` plus one image attachment with ID `image` returns the fixed `SmilingWolf/wd-eva02-large-tagger-v3` model name, comma-separated `prompt`, and confidence-sorted `keywords`.
- `ai.sdxl.t2i`: payload `{"model":"main-sdxl", "prompts":["..."], "format":"png"}` returns the selected `model`, image metadata, and each generated image as a DataChannel file attachment.
- `ai.sdxl.i2i`: requires one request attachment with ID `image`.
- `ai.sdxl.inpaint`: requires request attachments with IDs `image` and `mask`.
- `ai.sdxl.controlnet.t2i`: requires at least one request attachment with ID `scribble` or `pose`.
- `ai.sdxl.controlnet.i2i`: requires `image` plus at least one of `scribble` or `pose`.
- `ai.sdxl.controlnet.inpaint`: requires `image`, `mask`, plus at least one of `scribble` or `pose`.
- `ai.voicevox.speakers`: returns the installed VOICEVOX speaker metadata.
- `ai.voicevox.audio_query`: payload `{"text":"...", "speaker":2}` returns an editable `audio_query`.
- `ai.voicevox.synthesis`: payload `{"audio_query":{...}, "speaker":2}` returns a WAV DataChannel attachment.

The image-input handlers accept PNG, JPEG, and WebP attachments up to 20 MiB each. SDXL input images are resized to the requested output size. A mask is converted to grayscale; white pixels are regenerated and black pixels are preserved by the Diffusers inpaint pipeline. A fully white scribble is treated as inactive. When both controls are present, the runtime applies them in `scribble`, then `pose` order. ControlNet weights may be downloaded into the Hugging Face cache the first time a configured model is used.

CLIP uses its standard `~/.cache/clip` cache, while WD14 uses the Hugging Face cache selected by `HF_HOME` or `HUGGINGFACE_HUB_CACHE`. Model weights download on the first matching request; worker startup only warms imports. One CLIP model, one WD14 model, and one SDXL pipeline may remain loaded together on the image GPU. An overlapping GPU LLM lease remains exclusive. If a visual operation runs out of CUDA memory, the worker evicts the other co-resident visual models and retries that operation once.

The `model` field is optional on every generation handler. When omitted, the family default is used; explicit request settings override the selected model's TOML defaults. Every result includes the external model name that was actually used.

LLM `thinking_effort` accepts `default` or `low`, while `response_format` accepts `text` or `json`. JSON responses are validated as objects before being returned. When thinking is enabled, Gemma and Qwen reasoning markers are removed and only the final answer is exposed.

Install the optional CPU VOICEVOX 0.16.4 runtime from the AI project:

```powershell
cd app/slaves/ai
poetry run python scripts/install_voicevox.py
```

## Headless SDK usage

The browser and Python master SDKs call the same Caemble API that serves the rest of the application. No separate AI website or `masters/ai` application is required. Preserve the public v1 package and handler names when integrating third-party clients:

```python
import asyncio
import os

from gpstation_master import GpStationClient


async def main() -> None:
    async with GpStationClient(
        api_base_url="http://127.0.0.1:8000",
        token=os.environ["CAEMBLE_CLIENT_TOKEN"],
    ) as client:
        result = await client.run_job(
            "ai.llm",
            {
                "system_prompt": "Answer concisely.",
                "prompt": "Hello.",
                "max_tokens": 128,
            },
            slave_app_id="ai",
        )
        print(result.payload)


asyncio.run(main())
```

Example `ai.sdxl.t2i` payload:

```json
{
  "model": "main-sdxl",
  "prompts": ["a compact workstation on a clean desk"],
  "negative_prompts": [""],
  "seeds": [123],
  "step": 30,
  "cfg": 7,
  "height": 1024,
  "width": 1024,
  "format": "png"
}
```

Example `ai.sdxl.t2i` response payload:

```json
{
  "model": "main-sdxl",
  "images": [
    {
      "attachment_id": "image-1",
      "name": "sdxl-123.png",
      "format": "png",
      "mimeType": "image/png",
      "size": 12345,
      "seed": 123
    }
  ],
  "count": 1
}
```
