# Caemble worker applications

`app/slaves` contains the independent applications discovered by the launcher:

- `ai`: LLM/chat, embedding, image, tagging, and VOICEVOX handlers.
- `cae`: trusted-payload CAE simulation and Solver implementations.

Each `manifest.json` describes how the launcher starts an executable. It is not
a job-handler schema or Solver contract.

## Install and run

Install only the applications that a launcher machine should advertise. Poetry
creates a project-local `.venv` for each worker.

```powershell
Push-Location ai
Copy-Item models.example.toml models.toml
# Replace example names and paths with machine-local configuration.
poetry install
Pop-Location

Push-Location cae
poetry install
Pop-Location
```

Start the launcher from its own project after setting `CAEMBLE_API_URL` and a
one-time-displayed `launcher` token in `app/launcher/.env`:

```powershell
Push-Location ../launcher
poetry install
poetry run launcher
Pop-Location
```

The launcher advertises only workers with a runnable project-local interpreter.
It owns one worker and one job at a time; use another launcher for concurrency.

## AI configuration

`ai/models.toml` is ignored machine state. Configure the LLM, SDXL, and embedding
families described by `models.example.toml`, including a default for each.
Relative paths resolve from `app/slaves/ai`. The catalog is cached after a
successful load, so restart the worker after changing it.

Local llama.cpp models use `path`. OpenAI-backed model entries use
`provider = "openai"`, `model_id`, and the common `[llm.openai] api_key`; they
must not contain a local path. Never commit keys, model files, Hugging Face/CLIP
caches, VOICEVOX files, `.env`, or `.venv`.

Install the optional VOICEVOX 0.16.4 runtime with:

```powershell
Push-Location ai
poetry run python scripts/install_voicevox.py
Pop-Location
```

## Runtime ownership

Worker initialization warms imports but not every model weight. AI model state
and GPU residency are process-local. CAE Solver descriptors come only from the
shared SQLite catalog. Built Measurements and Catalog snapshots are trusted,
unversioned worker payloads; see the
[CAE README](cae/README.md) and [Solver development guide](../../docs/solver-development.md).

The GPStation v1 transport, attachment framing, and handler lifecycle are owned
by `app/sdk`; this version labels the transport, not CAE payload formats. The CAE
AST allowlist is an API guardrail rather than an OS sandbox, so production
workers run under a dedicated account or container. Deployment and launcher/API
configuration are documented in the repository
[deployment guide](../../deployment/deployment.md).
