# Caemble worker applications

Commands and component-relative paths in this document are relative to `app/slaves`, unless stated otherwise.

`app/slaves` contains the independent applications discovered by the launcher:

- `ai`: LLM/chat, embedding, image, tagging, and VOICEVOX handlers.
- `cae_simulation` (ID `cae`): trusted-payload CAE simulation and Solver implementations.
- `cae_evaluation` (ID `evaluation`): Node Measurement builds and Calculation for saved Optimizations.
- `tts`: CPU English Kokoro v1.0 synthesis, isolated from the AI application's dependencies.
- `cae_prediction` (ID `predictor`): Forward Prediction, local Dataset copies and persistent model artifacts.
  One environment provides WebRTC inference/management and the `predictor-training`
  WebSocket executable for independent training Jobs. The current algorithm is CPU kNN.

Each `manifest.json` describes how the launcher starts an executable. It is not
a job-handler schema or Solver contract.
An optional `entrypoints` array declares additional executable IDs with explicit
`module` and `job_mode`, sharing that manifest's directory and Python environment.
Each entrypoint has independent readiness and startup settings; IDs must be unique.

## Install and run

On Linux or WSL, install or update the Launcher and all five worker environments
with the repository-root script. The script resolves its checkout independently
of the current working directory; an absolute path containing spaces also works.

```bash
bash /path/to/caemble/li_launcher_install.sh
```

Have Poetry, Python 3.12 for new environments, Node 24.14 or later, the current
checkout's Poetry lockfiles and `deployment/caemble.tar.gz` available first.
Stop the Launcher before installation. The installer holds the Launcher state
lock until completion and refuses an already-running Launcher; it never stops or
restarts one. Relative `CAEMBLE_LAUNCHER_STATE_DIR` paths resolve from
`app/launcher`, matching Launcher startup.

Each project uses `poetry install --only main --no-interaction`. Shared Python
packages are installed through path dependencies. Compatible project-local
environments are reused. `predictor-training` shares the Prediction environment
and is installed once. Evaluation's `prepare` and `doctor` run against the shipped
Node archive; no npm install or UI build runs on the worker machine.

The script does not update Git, recalculate lockfiles, install OS packages or
download AI/TTS models. It preserves separately installed TTS language packages
by using `install`, not `sync`. On failure it identifies the project and stage;
completed installations remain available for a retry.

When upgrading the old folder layout, leave the old `.venv` directories in place;
the renamed projects receive new environments. Old `.env` and `runtime.toml`
settings are copied only when absent at the destination. Conflicting settings
stop installation without overwriting either file. Model stores, saved data and
caches remain intact. Configure AI models and prepare TTS separately below.

For individual development environments, run Poetry in the relevant project:

```powershell
Push-Location ai
Copy-Item models.example.toml models.toml
# Replace example names and paths with machine-local configuration.
poetry install
Pop-Location

Push-Location cae_simulation
poetry install
Pop-Location
```

For optimization, install Node 24.14 or later and the evaluation application on
at least one launcher:

```powershell
Push-Location cae_evaluation
poetry install
Pop-Location
```

On startup, after recovering previous executions and before connecting to the
server, the launcher runs the application's `prepare_args` once. Evaluation
prepares the `node/` subtree of `deployment/caemble.tar.gz` in the checkout's
`.data/node-runtime/<runtime_id>`, using the same installer and Node worker as the CLI. Matching build metadata and required
files are left untouched. A failed update preserves the previous bundle and
excludes Evaluation for this launcher run, with the cause printed to its console.
Reconnections and individual Jobs only check readiness; they do not install files.

No npm installation, build, or manual extraction is needed on the launcher machine.
Developers run `npm run build` in `app/ui` to build the web and shared Node runtime
and package the release. Ship that archive with the checkout. `build:node`,
`build:cli`, and `build:evaluation` only build the development runtime in `dist-cli`.
Each running process keeps its selected version; an update leaves earlier versions intact.
The optional `cae_evaluation/runtime.toml` sets an absolute `node` executable path.
`poetry run python -m app doctor` from `cae_evaluation` remains a read-only check of
Node, required runtime assets and build metadata. Restart the launcher after
updating it; only prepared, ready applications are advertised to the server.

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

## Predictor datasets and saved models

Install `cae_prediction` with `poetry install` in its own directory, then restart the
launcher. It uses CPU NumPy and the existing WebRTC/WebSocket SDK; it does not require a GPU,
the AI application, or a separate signaling service. In Prediction, select a saved
Forward model revision and then its replica and launcher. Calculation is optional.
Legacy Inverse assets remain available for management and backup/restore but cannot
be prepared or executed. A local model is never scheduled on another machine as a fallback.

Set `CAEMBLE_PREDICTOR_STORAGE_ROOT` in `app/launcher/.env` to keep Dataset and model
files on a chosen local disk. The default is `%LOCALAPPDATA%/Caemble/predictor` on
Windows and `~/.local/share/Caemble/predictor` otherwise. Keep this root across worker
upgrades. Its `storage-id` identifies the disk store independently of a worker PID
or session. Owner data lives under `owners/<SHA-256 of user ID>/`; the API supplies
the authenticated owner identity to the launcher. Account tokens are not passed
to the Predictor process.

Datasets downloaded from the server use a short-lived grant covering one revision
and its referenced objects. Predictor downloads the object bodies directly and
verifies their lengths and SHA-256 checksums. It retains the latest Dataset payload.
Saved models are self-contained, so replacing or deleting a Dataset does not alter
an existing model. Saving publishes a revision only after all artifact files and
its manifest are complete. Local persistence alone does not create a backup.

Accepted training belongs to a server Job, so closing a panel or browser does not
cancel it. Use the model manager's explicit cancel action. A selected Dataset is
locked against sync and file removal while training is queued, running or awaiting
process cleanup. A deletion request can remain pending until then.
CPU/GPU reservations and Dataset pins are released only after
cleanup. A worker or server interruption requires explicit retry; checkpoints and
automatic training resume are not implemented. If complete model files already
exist, retry verifies and registers them without training or needing the Dataset.
Otherwise retry requires the exact original Dataset revision and configuration.
Pre-submission pins left by a disconnected browser are reconciled against API
state on subsequent management access, never released solely by a local timeout.

Training and inference use separate algorithm resource profiles through the
existing Launcher ledger. Hybrid pins inference requirements with the model
revision and checks room for both Evaluation and Predictor. Upgrade the API, UI,
Launcher, Predictor and Evaluation together for Prediction protocol v3, including
API migration `000000000026`. Existing
artifact/archive v1 files and their checksums are preserved.

The API identifies a Dataset or model independently of its storage locations.
Local stores and object backups are replicas of an immutable revision; each local
store can have registered launcher access paths. Keep the `storage-id` with its
store rather than generating one for each launcher or copying it to an unrelated
disk. File verification and launcher connectivity are separate statuses. Existing
registrations migrate as unverified until a real file load or verification checks
the bytes. Metadata inspection alone does not prove that a file is intact.

Prediction's model manager creates object-storage backups using the API's existing
object storage configuration and owner authorization. Backup is explicit and defaults
to the model only. It includes the arrays and preprocessing needed for prediction;
the original training Dataset is optional. Including training data requires the exact
Dataset revision used by the model, from a retained server payload, reachable local
replica, or existing backup. An unavailable historical payload cannot be substituted
with the latest Dataset or reconstructed from a model. Routine Dataset synchronization
keeps the latest payload; explicit backup and restored historical payloads remain
available until separately removed.

Restore verifies checksums and atomically registers the same asset ID, revision and
manifest checksum at the selected destination store. It does not retrain or change
the model's definition. A model-only backup can restore inference after the original
store and Dataset are gone. Source launcher IDs, storage IDs, session handles and
grants are not execution requirements of the restored model. Backup packages do not
carry account credentials or download tokens. This release supports the same owner's
API-backed backup and restore, not cross-account publication or a separate storage
service. Predictor RPC is version `2`; Dataset and model artifact files remain
version `1` without rewriting model manifest bytes on restore.

Upgrade the API, UI and Predictor together after active Predictor jobs finish.
With a pre-upgrade database backup retained and database writers stopped, run
`poetry run alembic upgrade head` from `app/api` using the deployment's configured
database. Migration `000000000024` moves existing locations into replicas and
access paths, preserving unfinished preparation, pending deletion and leases.
It does not inspect local files or rewrite artifacts. The UI migrates saved setup
v1 to v2 on load, retaining model contracts and moving location fields into
execution preferences. Old Predictor RPC clients must update before reconnecting.
Schema downgrade cannot safely collapse multiple copies into one location; a
rollback requires the pre-upgrade database and matching application release.
Follow the [deployment procedure](deployment.md) for the production change window.

From the checkout, export a server Dataset as a portable local bundle:

```powershell
.\caemble.cmd doctor
.\caemble.cmd dataset export <dataset-id> --out .work/dataset-copy
.\caemble.cmd dataset validate .work/dataset-copy
```

If `doctor` reports a stale CLI, run `npm run build:cli` in `app/ui` and invoke
`node app/ui/dist-cli/caemble.cjs` for development. Export defaults to the current
revision; `--revision N` explicitly selects a retained payload. Retired Dataset
payloads cannot be exported. The output directory must be empty. Validation is
read-only and needs no server credentials or Solver execution.

A supported local bundle contains `manifest.json` with kind
`caemble.prediction.dataset.artifact`, version `1`, identity, revision, metadata,
and file lengths/checksums. `dataset.json` contains the exact immutable Dataset
manifest, and each stored object is `<sha256>.object`. Dataset files preserve Vars,
record meaning, coordinates and units. They do not contain account credentials or
download grants. Arbitrary CSV, NumPy files and directory layouts are not imported.

To stage a bundle on a launcher, copy the complete validated directory into
`<storage-root>/owners/<owner-hash>/imports/<import-id>`. Choose an opaque import ID
using letters, digits, `_` or `-`. Enter this import ID in Prediction's
**학습 데이터 → 고급: 외부 Dataset 가져오기** control. Predictor validates and copies the bundle into managed storage with a new
local Dataset identity, retaining the server source as provenance. The same import
ID remains bound to that source. Replace the staged bundle and explicitly update the Dataset to
publish a new local revision when its content changes. Models keep their existing
revision until explicitly updated. The source staging directory remains available
for the operator to manage; browser requests never contain an absolute local path.
See the [Predictor protocol](../../app/slaves/cae_prediction/README.md) for manifest and
operation contracts.

An open Prediction session retains CPU/RAM reservations. The UI finishes it after
five idle minutes and reloads the same saved model on the next prediction. Explicit
Cancel stops the caller and ignores late results while retaining reusable models.
Tab changes do not recreate the model. Connection loss invalidates the execution;
model files remain. Launcher reservations are returned only after the full process tree
exits. Reconnecting does not resume an unfinished preparation or create an updated
model automatically. The browser retains the selected Forward inference session
independently of Vars and optional Calculation selection.

Management jobs have a separate lifetime from inference and from the management
panel. Closing the panel does not cancel a preparation, backup or restore. Transfer
jobs request one CPU and 256 MiB startup RAM; independent training uses its algorithm's
training requirements and the Launcher's training defaults. Backup and restore allow up to 30 minutes per RPC, while file
verification and removal allow up to 10 minutes. Resource admission still applies.
After interruption, inspect the persisted operation and retry the same operation;
completed transfers and registrations are reused. The UI switches a model selection
only after successful creation or an explicit **복원하고 사용** action, and only if
the user has not selected something newer while waiting.

Removing one replica differs from deleting the whole asset. Whole-model deletion
targets all revisions and model copies, while Dataset deletion preserves models and
the original Experiment records. Active leases and unreachable launchers leave a
deletion pending until the file removal can be confirmed. A disconnected launcher
does not imply that its files are missing. Inspect the pending operation before
retrying; an API tombstone prevents late registration from resurrecting a deleted asset.

Developer acceptance uses an isolated loopback fixture with real Chromium, SDK
DataChannels and launcher-managed subprocesses. Build `shared/sdk/master/js`, install
the UI's Playwright dependency, SDK `[slave]` and Predictor environments, then run from
`app/launcher`:

```powershell
$env:RUN_WEBRTC_BROWSER_TESTS = '1'
poetry run python -m pytest tests/test_webrtc_browser.py tests/test_predictor_browser.py -q
```

These tests substitute HTTP scheduling only. They verify binary transfers, new
process identity after restart, cancellation, disconnect and confirmed resource
cleanup. The Predictor test loads saved Forward fixtures, backs up the
model, removes the source store, and restores into a different storage identity.
A fresh third Predictor process loads the restored files and checks unchanged
manifest checksums, provenance and predictions. They do not claim production
signaling or NAT traversal verification.

The independent training entrypoint also has a real process acceptance test. It
uses a loopback HTTP Dataset grant and WebSocket server, trains without an inference
session or browser, and verifies progress, saved artifacts and process/resource cleanup:

```powershell
$env:RUN_PREDICTOR_PROCESS_TESTS = '1'
poetry run python -m pytest tests/test_predictor_training.py -q
```

## Launcher resource policy

Copy `app/launcher/resources.example.toml` to
`app/launcher/resources.toml` in the same directory, or select a file with
`CAEMBLE_RESOURCES_FILE`. Restart the launcher after editing it. The Launchers
page displays budgets, reservations, running instances and waiting reasons;
configuration is edited on the launcher machine.

The default path is relative to the launcher installation, regardless of the
current working directory. `CAEMBLE_RESOURCES_FILE` takes precedence. For existing
installations, `.data/resources.toml` is still read when `resources.toml` is absent;
when both exist, the file beside `resources.example.toml` wins.

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

## English TTS configuration

The `tts` worker uses its own Python 3.12 environment and exposes
`ai.kokoro.synthesis`. Install and prepare it explicitly before restarting the
launcher:

```powershell
Push-Location tts
poetry env use 3.12
poetry install
poetry run python -m app prepare
poetry run python -m app doctor
poetry run python -m app smoke
Pop-Location
```

Preparation downloads the pinned Kokoro model and US `af_heart` voice into
`tts/.models/kokoro-v1.0`, plus the English G2P package. `doctor` checks local
readiness; `smoke` performs actual CPU synthesis and creates
`tts/.data/kokoro-smoke.wav` for listening. No model download occurs during
worker initialization or synthesis. A missing asset excludes TTS from launcher
advertisements with a preparation error.

Use `slaveAppId: "tts"` with CPU-only resources (`gpu_count = 0`) in a separate
GPStation job. SDXL continues to use the `ai` worker and its own GPU allocation.
See the [TTS worker contract](../../app/slaves/tts/README.md) for payload,
preprocessing metadata, offline regression tests and local model configuration.

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
by `shared/sdk`. Execution protocol 2 requires the API, launcher, slave and master
SDKs to be upgraded together; it does not version CAE payload formats. The CAE
AST allowlist is an API guardrail rather than an OS sandbox, so production
workers run under a dedicated account or container. Deployment and launcher/API
configuration are documented in the repository
[deployment guide](deployment.md).
