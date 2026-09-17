# Caemble worker applications

Commands and component-relative paths in this document are relative to `app/slaves`, unless stated otherwise.

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

## CAE CPU allocation

CAE uses half the available logical CPUs by default, rounded down with a minimum
of one. The available count respects process CPU affinity. Set
`CAEMBLE_CAE_CPU_BUDGET=3` in the launcher's `.env` to override this default;
the value must be a positive integer and is clamped to the available CPU count.
Restart the worker after changing the setting. Local CLI executions read the
same variable from their process environment:

```powershell
$env:CAEMBLE_CAE_CPU_BUDGET = '3'
```

This is a computation budget, not a percentage CPU usage throttle. Ray tracing
uses up to that many single-threaded computation processes; fewer than 512
initial rays run inside the Solver process. CPU FDTD uses the budget for Torch
intra-op threads and one inter-op thread. CUDA selection is unchanged.
Large Ray tallies can reduce the worker count to keep estimated additional tally
and transfer buffers within half the currently available memory. This estimate
is not a total memory limit; geometry and Python object memory are additional.

Configure each launcher separately when sharing a machine. There is no global
budget allocator across launchers or simultaneous local CLI processes. Runtime
logs show the requested/effective CPU budget, pool process IDs and Torch thread
counts. CPU configuration is not an Experiment or Solver physical parameter.

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
[CAE README](../development/cae.md) and [Solver development guide](../development/solver-development.md).

The GPStation v1 transport, attachment framing, and handler lifecycle are owned
by `app/sdk`; this version labels the transport, not CAE payload formats. The CAE
AST allowlist is an API guardrail rather than an OS sandbox, so production
workers run under a dedicated account or container. Deployment and launcher/API
configuration are documented in the repository
[deployment guide](deployment.md).
