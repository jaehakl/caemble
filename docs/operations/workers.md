# Caemble worker applications

Commands and component-relative paths in this document are relative to `app/slaves`, unless stated otherwise.

`app/slaves` contains the independent applications discovered by the launcher:

- `ai`: LLM/chat, embedding, image, tagging, and VOICEVOX handlers.
- `cae`: trusted-payload CAE simulation and Solver implementations.
- `evaluation`: Node Measurement builds and Calculation for saved optimization Studies.

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

For optimization, install Node 24.14 or later and the evaluation application on
at least one launcher. Build its runtime from the same checkout:

```powershell
Push-Location ../ui
npm ci
npm run build:evaluation
Pop-Location
Push-Location evaluation
poetry install
poetry run python -m app doctor
Pop-Location
```

Alternatively extract `deployment/caemble-evaluation.tar.gz` into
`app/slaves/evaluation/dist`. The bundle includes its TypeScript declarations
and `build-info.json`; copying only `evaluation.cjs` is insufficient. The
optional `evaluation/runtime.toml` sets an absolute `node` executable path.
Doctor checks Node, required runtime assets and the build metadata version.
The launcher advertises Evaluation only when this
application-owned readiness check succeeds. Restart the launcher after installation.

Evaluation receives stage inputs over the existing job WebSocket. Python owns
object transfers and starts a disposable Node child with source/data only and
a restricted environment. Cancellation and timeout reap that child; the
launcher retains the reservation until the full attempt process tree exits.
Build and Calculation jobs use CPU-only allocations and release them between
stages. Solver jobs continue to use the existing CAE worker.

Start the launcher from its own project after setting `CAEMBLE_API_URL` and a
one-time-displayed `launcher` token in `app/launcher/.env`:

```powershell
Push-Location ../launcher
poetry install
poetry run launcher
Pop-Location
```

The launcher advertises only workers with a runnable project-local interpreter.
It starts a fresh slave process for each execution attempt. One instance owns
one active Job; several instances of the same or different applications can run
within one launcher's resource budget. Committed Batch items wait when resources
are unavailable and start automatically after earlier instances finish cleanup.

## Launcher resource policy

Copy `app/launcher/resources.example.toml` to
`app/launcher/.data/resources.toml`, or select a file with
`CAEMBLE_RESOURCES_FILE`. Restart the launcher after editing it. The Launchers
page displays budgets, reservations, running instances and waiting reasons;
configuration is edited on the launcher machine.

If the file omits `cpu_cores`, an existing `CAEMBLE_CAE_CPU_BUDGET` launcher
setting supplies the total launcher CPU budget. An explicit policy-file value
takes precedence; per-job CPU requests belong in profiles or submission overrides.

```toml
cpu_cores = 12
ram_budget_bytes = 68719476736
startup_ram_bytes = 1073741824

[defaults.cae]
cpu_cores = 4
gpu_count = 0

[defaults.ai]
cpu_cores = 4
gpu_count = 0

[defaults."ai.sdxl.inpaint"]
gpu_count = 1
gpu_memory_bytes = 8589934592
```

Omitted machine budgets use half the logical CPUs available to the launcher
(rounded down, minimum one) and half physical RAM. Per-job defaults are up to
four CPUs, 1 GiB startup RAM, and no GPU. Application defaults are overlaid by a
handler profile and then explicit API/CLI resource fields. `gpu_count = 0`
requests CPU-only execution; a positive count requires that many exclusively
allocated devices. There is no automatic fallback from a required GPU to CPU.
`gpu_memory_bytes` is the required free memory per device. GPU UUIDs are
discovered through `nvidia-smi`; optional `gpu_devices = ["GPU-..."]` at the
top level restricts the devices the launcher manages.

The API proposes compatible jobs in Batch rotation order. The launcher checks
and reserves CPU IDs, startup allowance and GPU devices under one lock before
authorizing a process. Duplicate proposals reuse the reservation; stale reports
cannot bypass this local check. A 12-CPU budget and four CPUs per job therefore
allow up to three concurrent jobs when the RAM and GPU checks also pass.

RAM admission uses observed process-tree RSS, including launcher RSS. Let `R`
be that observed total, `U` the unobserved startup allowance for existing
reservations, `S` the new job's startup allowance, `G` growth headroom, and `H`
system headroom. A new reservation requires both:

```text
R + U + S + G <= launcher RAM budget
OS available RAM >= U + S + G + H
```

For each starting instance, the allowance is `max(0, startup estimate - RSS)`;
it expires after two complete running samples. The default `G` is the larger of
1 GiB or 10% of the launcher RAM budget. The default `H` is the larger of 2 GiB
or 10% of physical RAM. Configure them with `ram_growth_headroom_bytes` and
`system_ram_headroom_bytes`. Missing or stale telemetry pauses new admissions.
`sample_interval_seconds` defaults to `1`; `metrics_max_age_seconds` defaults
to `3`. Both must be positive, and the maximum age must be at least the sample
interval. Two distinct complete observations after the instance starts running
are required before its startup allowance expires.
These estimates and RSS samples are not an OS-enforced memory ceiling and do
not prevent later memory growth or allocation failure. Other programs' usage
reduces OS available RAM. The worker's advisory RAM allowance is also bounded
by its CPU share of the launcher budget and checked against live available RAM.

GPU admission leaves the larger of 1 GiB or 10% of device memory free in addition
to the requested memory. A device remains exclusively reserved until the full
attempt process tree exits, including any retained model or cache. No automatic
preemption or GPU sharing is performed.

## Computation inside an instance

The bootstrap waits for process containment before importing an application.
It applies the allocated CPU affinity and native-library thread limits, and
sets `CUDA_VISIBLE_DEVICES` to the allocated UUIDs. GPU indices in application
configuration refer to this visible list: one allocated GPU is device `0`
regardless of its host index. Invalid AI device or tensor-split settings fail
that instance. CPU-only LLM execution disables GPU offload; SDXL requires a GPU
profile. Llama decoding and prompt batches, Torch, and VOICEVOX respect the CPU
allocation, including settings that otherwise select all CPUs automatically.

Windows CPU affinity currently supports one processor group. CPU identifiers
outside that group's affinity mask are rejected before the application starts;
allocation across multiple Windows processor groups is not supported.

Managed CAE receives its CPU budget from the allocation. Standalone local CLI
execution retains the default of half the CPUs available through affinity and
accepts a positive override, clamped to the available count:

```powershell
$env:CAEMBLE_CAE_CPU_BUDGET = '3'
```

This is a computation budget, not a percentage CPU usage throttle. Ray tracing
uses up to that many single-threaded computation processes; fewer than 512
initial rays run inside the Solver process. CPU FDTD uses the budget for Torch
intra-op threads and one inter-op thread. Only assigned GPUs are visible.
Large Ray tallies can reduce the worker count to keep estimated additional tally
and transfer buffers within half the currently available memory and the managed
advisory RAM allowance. This estimate
is not a total memory limit; geometry and Python object memory are additional.

Parallel Batch items are independent Jobs. The Solver order and physical
connections defined by one Measurement's `simulate.py` remain unchanged.
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
and GPU residency are process-local and cold for each new Job; an open WebRTC
session retains them until that Job ends. A terminal event and handler cleanup
start process teardown. Reservations are returned only after the process tree
has exited, then the next waiting job can start. Failure or cancellation affects
only that instance.

Launcher control reconnect has a default 30-second grace period, configured by
`CAEMBLE_CONTROL_GRACE_SECONDS`. During the grace period it accepts no new
assignments and reconciles existing instances on reconnect. A broken CAE result
WebSocket cannot replay an interrupted computation: the attempt fails, cleans
up, and requires manual retry. Restarted attempts get new identities; duplicate
or previous-attempt messages cannot publish results or release another reservation.

CAE Solver descriptors come only from the
shared SQLite catalog. Built Measurements and Catalog snapshots are trusted,
unversioned worker payloads; see the
[CAE README](../development/cae.md) and [Solver development guide](../development/solver-development.md).

The GPStation v1 API, attachment framing, and handler lifecycle are owned
by `app/sdk`. Execution protocol 2 requires the API, launcher, slave and master
SDKs to be upgraded together; it does not version CAE payload formats. The CAE
AST allowlist is an API guardrail rather than an OS sandbox, so production
workers run under a dedicated account or container. Deployment and launcher/API
configuration are documented in the repository
[deployment guide](deployment.md).
