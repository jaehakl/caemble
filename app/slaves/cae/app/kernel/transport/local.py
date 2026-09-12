"""Local CLI transport for the existing CAE validator, catalog and run coordinator."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib
import importlib.metadata
import importlib.util
import json
import os
import signal
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from caemble_catalog import CatalogNotFoundError, catalog_path, open_catalog

from app.kernel.api.errors import CaeError


def write_json(path: Path, value: Any) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def catalog_query(args: argparse.Namespace) -> Any:
    with open_catalog(args.database, immutable=False) as catalog:
        if args.resource == "meta":
            return catalog.meta()
        if args.resource == "search":
            return catalog.search(args.query or "", limit=args.limit)
        if args.resource == "solvers":
            return catalog.list_solvers(query=args.query)
        if args.resource == "solver":
            version = args.version
            if version is None:
                matches = [item for item in catalog.list_solvers() if item["name"] == args.key]
                if len(matches) != 1:
                    raise CatalogNotFoundError("Select an exact Solver name and version.")
                version = matches[0]["version"]
            manifest = catalog.get_solver_manifest(args.key, version)
            return {
                **catalog.solver_detail(args.key, version),
                "implementation": manifest["implementation"],
                "abiVersion": manifest["abiVersion"],
            }
        if args.resource in {"quantity-kinds", "material-models", "examples"}:
            readers = {
                "quantity-kinds": catalog.list_quantity_kinds,
                "material-models": catalog.list_material_models,
                "examples": catalog.list_experiments,
            }
            items, total = readers[args.resource](query=args.query, limit=args.limit, offset=args.offset)
            return {"items": items, "total": total}
        if args.resource == "quantity-kind":
            return {**catalog.quantity_kind(args.key), **catalog.quantity_kind_relations(args.key)}
        if args.resource == "material-model":
            return catalog.material_model(args.key)
        if args.resource == "artifact-types":
            return catalog.artifact_types()
        if args.resource == "artifact-type":
            return catalog.artifact_type(args.key)
        if args.resource == "example":
            return catalog.experiment(args.key, version=args.version)
        if args.input is not None:
            request = json.loads(args.input.read_text(encoding="utf-8"))
        else:
            meta = catalog.meta()
            request = {
                "solvers": catalog.list_solvers(),
                "quantityKinds": [item["name"] for item in catalog.list_quantity_kinds(limit=meta["quantityKindCount"])[0]],
                "materialModels": [item["key"] for item in catalog.material_models()],
            }
        return catalog.runtime_slice(
            solvers=[(item["name"], item["version"]) for item in request.get("solvers", [])],
            quantity_kinds=request.get("quantityKinds", []),
            material_models=request.get("materialModels", []),
        )


def doctor() -> dict[str, Any]:
    import app
    import caemble_catalog
    import sdk

    dependencies = {}
    for package, module in (
        ("pytest", "pytest"), ("pytest-asyncio", "pytest_asyncio"),
        ("numpy", "numpy"), ("manifold3d", "manifold3d"),
        ("torch", "torch"), ("ucumvert", "ucumvert"), ("websockets", "websockets"),
        ("caemble-catalog", "caemble_catalog"), ("caemble-runtime-sdk", "sdk"),
    ):
        try:
            version = importlib.metadata.version(package)
            spec = importlib.util.find_spec(module)
            if spec is None:
                raise ModuleNotFoundError(f"Module {module} is unavailable.")
            if module == "pytest":
                version = importlib.import_module(module).__version__
            dependencies[package] = {"available": True, "version": version, "modulePath": spec.origin}
        except Exception as error:
            dependencies[package] = {"available": False, "error": str(error)}

    modules = {
        "cae": str(Path(app.__file__).resolve()),
        "catalog": str(Path(caemble_catalog.__file__).resolve()),
        "sdk": str(Path(sdk.__file__).resolve()),
    }
    runtime_revision = None
    runtime_error = None
    try:
        from app.kernel.catalog import solver_catalog
        from app.kernel.coordinator import program, run

        modules.update({
            "program": str(Path(program.__file__).resolve()),
            "runtime": str(Path(run.__file__).resolve()),
        })
        runtime_revision = solver_catalog.catalog_revision
    except Exception as error:
        runtime_error = str(error)

    with open_catalog() as catalog:
        meta = catalog.meta()
    return {
        "ready": runtime_error is None and runtime_revision == meta["catalogRevision"] and all(item["available"] for item in dependencies.values()),
        "python": sys.executable,
        "pythonVersion": sys.version.split()[0],
        "modules": modules,
        "dependencies": dependencies,
        **({"runtimeError": runtime_error} if runtime_error is not None else {}),
        "catalogPath": str(catalog_path().resolve()),
        "catalogRevision": meta["catalogRevision"],
        "runtimeCatalogRevision": runtime_revision,
        "catalog": meta,
    }


async def run_local(
    input_path: Path,
    output: Path,
    catalog_revision: str,
    timeout: float,
    cancelled: asyncio.Event,
    *,
    input_hash: str | None = None,
) -> dict[str, Any]:
    from app.kernel.coordinator.run import CaeRun
    from app.kernel.catalog import solver_catalog
    from app.kernel.transport.records import RecordPacket

    actual_revision = solver_catalog.catalog_revision
    if actual_revision != catalog_revision:
        raise CaeError(
            "catalog_revision_mismatch",
            f"Built input uses Catalog {catalog_revision}; local CAE uses {actual_revision}. "
            "Build against the checkout Catalog, or publish the Draft explicitly before starting a new local run.",
        )
    input_bytes = input_path.read_bytes()
    actual_input_hash = hashlib.sha256(input_bytes).hexdigest()
    if input_hash is not None and actual_input_hash != input_hash:
        raise CaeError("artifact_input_mismatch", "Built input changed before the local CAE process read it.")
    item = json.loads(input_bytes.decode("utf-8"))
    measurement = item.get("measurement", item)
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise FileExistsError(f"Local result directory must be empty: {output}")
    records_directory = output / "records"
    records_directory.mkdir()
    manifest_path = output / "manifest.json"
    manifest: dict[str, Any] = {
        "kind": "local-cae-result",
        "state": "running",
        "input": str(input_path.resolve()),
        "inputHash": actual_input_hash,
        "catalogRevision": actual_revision,
        "sourceHash": measurement["experiment"].get("sourceHash"),
        "jobId": f"local-{uuid.uuid4()}",
        "records": [],
        "recordSequences": [],
        "visualizations": [],
        "visualizationSequences": [],
        "recordedBytes": 0,
        "trace": [],
    }
    write_json(manifest_path, manifest)
    started = time.perf_counter()
    run: CaeRun | None = None
    pending: asyncio.Task | None = None
    cancellation = asyncio.create_task(cancelled.wait())

    async def progress(value: Any) -> None:
        print(json.dumps({"type": "progress", "progress": value}, ensure_ascii=False), file=sys.stderr, flush=True)

    try:
        run = CaeRun(
            measurement=measurement,
            max_run_seconds=timeout,
            job_id=manifest["jobId"],
            on_progress=progress,
        )
        if cancelled.is_set():
            raise asyncio.CancelledError
        run.start()
        while True:
            pending = asyncio.create_task(run.queue.get())
            await asyncio.wait((pending, cancellation), return_when=asyncio.FIRST_COMPLETED)
            if cancelled.is_set():
                raise asyncio.CancelledError
            packet = pending.result()
            pending = None
            if isinstance(packet, RecordPacket):
                run.pending = packet
                attachments = []
                directory = "visualizations" if packet.kind == "visualization" else "records"
                (output / directory).mkdir(exist_ok=True)
                for index, attachment in enumerate(packet.attachments):
                    relative_path = f"{directory}/{packet.sequence:04d}-{index:04d}.bin"
                    (output / relative_path).write_bytes(attachment.data)
                    attachments.append({
                        "id": attachment.id,
                        "path": relative_path,
                        "mimeType": attachment.mimeType,
                        "byteLength": len(attachment.data),
                    })
                if packet.kind == "visualization":
                    visual = {"sequence": packet.sequence, "task": packet.name,
                              "path": f"visualizations/{packet.sequence:04d}.json", "attachments": attachments}
                    write_json(output / visual["path"], {**visual, "visualizations": packet.value})
                    manifest["visualizations"] = [item for item in manifest["visualizations"] if item["task"] != packet.name] + [visual]
                    write_json(manifest_path, manifest)
                    run.acknowledge(packet.sequence)
                    continue
                record = {
                    "sequence": packet.sequence,
                    "name": packet.name,
                    "path": f"records/{packet.sequence:04d}.json",
                    "schema": measurement["experiment"]["simulationProgram"]["recordedData"][packet.name],
                    "attachments": attachments,
                }
                write_json(output / record["path"], {**record, "value": packet.value})
                manifest["records"].append(record)
                write_json(manifest_path, manifest)
                run.acknowledge(packet.sequence)
                continue
            if packet["kind"] == "failed":
                raise CaeError(packet["error"]["code"], packet["error"]["message"])
            if packet["kind"] == "complete":
                await run.task
                manifest["state"] = "succeeded"
                break
    except asyncio.CancelledError:
        manifest["state"] = "cancelled"
        manifest["error"] = {"code": "cancelled", "message": "Local simulation cancelled."}
    except Exception as error:
        manifest["state"] = "failed"
        manifest["error"] = {"code": getattr(error, "code", "local_run_failed"), "message": str(error) or type(error).__name__}
        if manifest["error"]["code"] in {"timeout", "run_timeout"}:
            manifest["error"]["exitCode"] = 5
    finally:
        cancellation.cancel()
        if pending is not None:
            pending.cancel()
        await asyncio.gather(cancellation, *([pending] if pending is not None else []), return_exceptions=True)
        if run is not None:
            await run.close()
            manifest["recordSequences"] = run.completed_sequences
            manifest["visualizationSequences"] = run.visualization_sequences
            manifest["recordedBytes"] = run.recorded_bytes
            manifest["trace"] = run.trace
        manifest["durationMs"] = round((time.perf_counter() - started) * 1000)
        write_json(manifest_path, manifest)
    return {**manifest, "manifestPath": str(manifest_path.resolve())}


async def run_with_cancellation(args: argparse.Namespace) -> dict[str, Any]:
    cancelled = asyncio.Event()
    loop = asyncio.get_running_loop()

    def read_commands() -> None:
        buffered = b""
        while True:
            try:
                chunk = os.read(sys.stdin.fileno(), 4096)
            except OSError:
                return
            if not chunk:
                return
            buffered += chunk
            while b"\n" in buffered:
                line, buffered = buffered.split(b"\n", 1)
                try:
                    command = json.loads(line)
                except ValueError:
                    continue
                if isinstance(command, dict) and command.get("type") == "cancel":
                    try:
                        loop.call_soon_threadsafe(cancelled.set)
                    except RuntimeError:
                        pass
                    return

    # Raw reads avoid holding a buffered stdin lock during interpreter shutdown;
    # a daemon also leaves asyncio's executor free when the parent keeps its pipe open.
    threading.Thread(target=read_commands, daemon=True, name="cae-local-commands").start()
    previous = {number: signal.getsignal(number) for number in (signal.SIGINT, signal.SIGTERM)}
    for number in previous:
        signal.signal(number, lambda *_: loop.call_soon_threadsafe(cancelled.set))
    try:
        return await run_local(args.input, args.out, args.catalog_revision, args.timeout, cancelled, input_hash=args.input_hash)
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("doctor")
    catalog = commands.add_parser("catalog")
    catalog.add_argument("resource", choices=(
        "meta", "search", "solvers", "solver", "quantity-kinds", "quantity-kind",
        "material-models", "material-model",
        "artifact-types", "artifact-type", "examples", "example", "runtime",
    ))
    catalog.add_argument("--database", type=Path)
    catalog.add_argument("--key")
    catalog.add_argument("--version")
    catalog.add_argument("--query")
    catalog.add_argument("--input", type=Path)
    catalog.add_argument("--limit", type=int, default=100)
    catalog.add_argument("--offset", type=int, default=0)
    validate = commands.add_parser("validate")
    validate.add_argument("--input", type=Path, required=True)
    run = commands.add_parser("run")
    run.add_argument("--input", type=Path, required=True)
    run.add_argument("--input-hash")
    run.add_argument("--out", type=Path, required=True)
    run.add_argument("--catalog-revision", required=True)
    run.add_argument("--timeout", type=float, default=7200)
    args = parser.parse_args(argv)
    source_hash = None
    try:
        if args.command == "doctor":
            result = doctor()
        elif args.command == "catalog":
            result = catalog_query(args)
        elif args.command == "validate":
            from app.kernel.coordinator.program import validate_and_load_simulate

            item = json.loads(args.input.read_text(encoding="utf-8"))
            measurement = item.get("measurement", item)
            source_hash = measurement["experiment"].get("sourceHash")
            manifest = measurement["experiment"]["simulationProgram"]
            validate_and_load_simulate(
                manifest["pythonSource"], task_names=manifest["tasks"], recorded_names=manifest["recordedData"],
            )
            result = {"valid": True, "tasks": list(manifest["tasks"]), "recordedData": list(manifest["recordedData"])}
        else:
            result = asyncio.run(run_with_cancellation(args))
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")), flush=True)
        if args.command == "run":
            return 0 if result["state"] == "succeeded" else 130 if result["state"] == "cancelled" else result.get("error", {}).get("exitCode", 1)
        return 0
    except Exception as error:
        problem = {"code": getattr(error, "code", "local_error"), "message": str(error) or type(error).__name__}
        if problem["code"] == "artifact_input_mismatch":
            problem["exitCode"] = 4
        if args.command == "validate":
            cause = error.__cause__
            location = None
            if isinstance(cause, SyntaxError) and cause.lineno is not None and cause.offset is not None:
                location = {"file": "simulate.py", "line": cause.lineno, "column": cause.offset}
            problem.update({
                "stage": "python",
                "language": "python",
                "sourceHash": source_hash,
                "referenceId": "experiment.simulate",
            })
            problem["diagnostics"] = [{**problem, "location": location}]
        print(json.dumps({"error": problem}, ensure_ascii=False), flush=True)
        return problem.get("exitCode", 1)


if __name__ == "__main__":
    raise SystemExit(main())
