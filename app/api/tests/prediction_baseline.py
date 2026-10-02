"""Opt-in real Box conductor baseline; writes only isolated local test artifacts.

Run from the checkout with the API Python environment. Each of nine fresh CLI
build/solve conditions has a 180-second end-to-end budget. Predictor training and
fresh-process inference compare kNN and MLP using the identical held-out designs.
This does not submit Hybrid jobs or connect to an application database.
"""
from __future__ import annotations

import argparse
import base64
from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from uuid import uuid4

import psutil

ROOT = Path(__file__).resolve().parents[3]
PREDICTOR = ROOT / "app/slaves/cae_prediction"
CLI = ROOT / "app/ui/dist-cli/caemble.cjs"
sys.path.insert(0, str(ROOT / "shared"))


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2), encoding="utf-8")


def run_command(command: list[str], log: Path, timeout: float, env=None) -> dict:
    """Bound the complete child tree and retain diagnostic logs on failure."""
    started, observed = time.perf_counter(), {}
    with log.open("w", encoding="utf-8") as output:
        process = subprocess.Popen(command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, env=env)
        try:
            while process.poll() is None:
                try:
                    for child in psutil.Process(process.pid).children(recursive=True):
                        observed[child.pid] = child.create_time()
                except psutil.Error:
                    pass
                if time.perf_counter() - started >= timeout:
                    raise TimeoutError(f"Command exceeded {timeout:.1f}s; see {log}")
                try:
                    process.wait(timeout=.1)
                except subprocess.TimeoutExpired:
                    pass
        finally:
            if process.poll() is None:
                try:
                    children = psutil.Process(process.pid).children(recursive=True)
                except psutil.Error:
                    children = []
                for child in children:
                    try:
                        child.kill()
                    except psutil.Error:
                        pass
                process.kill()
                process.wait(timeout=15)
                psutil.wait_procs(children, timeout=15)
    survivors = []
    for pid, created in observed.items():
        try:
            if psutil.Process(pid).create_time() == created:
                survivors.append(pid)
        except psutil.Error:
            pass
    if process.returncode or survivors:
        raise RuntimeError(f"Command failed ({process.returncode}), remaining children {survivors}; see {log}")
    return {"elapsedSeconds": time.perf_counter() - started, "exitCode": process.returncode,
            "observedChildren": len(observed), "remainingChildren": survivors, "log": str(log)}


def build_dataset(work: Path, report: dict, report_path: Path) -> Path:
    dataset = None
    for identity, (length, width) in enumerate(((length, width) for length in (4, 5, 6)
                                               for width in (.8, 1., 1.2)), 1):
        started = time.perf_counter()
        point = work / f"point-{identity:02d}"
        point.mkdir()
        values = {"length": length, "width": width}
        write_json(point / "vars.json", values)
        build = run_command(["node", str(CLI), "experiment", "build", "--example", "hybrid-box-conductor",
            "--mode", "candidate", "--vars", str(point / "vars.json"), "--out", str(point / "artifact")],
            point / "build.log", 180)
        remaining = 180 - (time.perf_counter() - started)
        if remaining <= 15:
            raise TimeoutError("Build left no cleanup allowance inside the 180-second condition budget.")
        solve = run_command(["node", str(CLI), "experiment", "test", str(point / "artifact"),
            "--out", str(point / "result"), "--timeout", str(remaining - 15)], point / "solve.log", remaining)
        built = json.loads((point / "artifact/items/1.json").read_text(encoding="utf-8"))["measurement"]["experiment"]
        program = built["simulationProgram"]
        result_root = point / "result/1"
        result = json.loads((result_root / "manifest.json").read_text(encoding="utf-8"))
        if result["state"] != "succeeded" or {row["name"] for row in result["records"]} != {"currentDensity", "totalCurrent"}:
            raise AssertionError("The fresh Solver run must record both declared BoxGrid outputs.")
        if dataset is None:
            dataset = {"kind": "caemble.prediction.dataset", "version": 1, "datasetId": str(uuid4()), "revision": 1,
                "name": "Fresh nine-point Box conductor baseline", "experimentId": 1,
                "sourceHash": built["sourceHash"], "varsSchema": built["varsSchema"],
                "measurements": [], "recorded": [], "records": [], "rules": [],
                "resultContracts": program["resultContracts"], "calculations": [], "calculationData": []}
            for record_id, name in enumerate(sorted(program["recordedData"]), 1):
                schema = program["recordedData"][name]
                contract = program["resultContracts"][name]
                output = next(item for item in program["tasks"][contract["task"]]["config"]["outputs"]
                              if item["key"] == contract["output"])
                dataset["records"].append({"id": record_id, "name": name, "data_schema": schema,
                    "contract_hash": hashlib.sha256(json.dumps(schema, sort_keys=True).encode()).hexdigest()})
                dataset["rules"].append({"label": name, "target": output["target"], "methodId": output["methodId"],
                                         "parameters": output["parameters"], "result": schema})
        if built["sourceHash"] != dataset["sourceHash"] or built["varsSchema"] != dataset["varsSchema"]:
            raise AssertionError("The baseline must keep one source and Vars schema.")
        dataset["measurements"].append({"id": identity, "vars": built["variables"]})
        by_name = {record["name"]: record for record in dataset["records"]}
        for row in result["records"]:
            tensor = json.loads((result_root / row["path"]).read_text(encoding="utf-8"))["value"]
            if tensor["storage"]["kind"] == "attachment":
                attachment = next(item for item in row["attachments"] if item["id"] == tensor["storage"]["attachmentId"])
                raw = (result_root / attachment["path"]).read_bytes()
                if len(raw) != attachment["byteLength"]:
                    raise AssertionError("Solver attachment length differs from its manifest.")
                tensor["storage"] = {"kind": "base64", "data": base64.b64encode(raw).decode("ascii"), "byteLength": len(raw)}
            dataset["recorded"].append({"id": len(dataset["recorded"]) + 1, "name": row["name"],
                "measurement_id": identity, "experiment_record_id": by_name[row["name"]]["id"],
                "dtype": row["schema"]["dtype"], "data_schema": row["schema"], "data": tensor})
        elapsed = time.perf_counter() - started
        if elapsed > 180:
            raise TimeoutError("Condition exceeded its 180-second build/solve/record/cleanup budget.")
        report["conditions"].append({"measurementId": identity, "vars": values, "elapsedSeconds": elapsed,
            "build": build, "solve": solve, "recordCount": len(result["records"]), "state": result["state"]})
        write_json(report_path, report)
        print(f"Condition {identity}/9 completed in {elapsed:.2f}s", flush=True)
    dataset["fingerprint"] = "sha256:" + hashlib.sha256(json.dumps(dataset, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    target = work / "dataset.json"
    write_json(target, dataset)
    return target


def initialize_backend(algorithm: str, device: str):
    """Keep cold Torch import and CUDA context creation inside the phase timer."""
    started = time.perf_counter()
    if algorithm != "mlp":
        return None, 0.0
    import torch
    from sdk.slave.execution import configure_torch
    configure_torch(torch)
    if device == "cuda":
        torch.cuda.init()
        torch.cuda.synchronize()
    return torch, time.perf_counter() - started


def begin_cuda_memory(torch) -> dict:
    torch.cuda.synchronize()
    torch.cuda.reset_peak_memory_stats()
    return {"scope": "torch-caching-allocator", "baselineAllocatedBytes": torch.cuda.memory_allocated(),
            "baselineReservedBytes": torch.cuda.memory_reserved()}


def finish_cuda_memory(torch, baseline: dict) -> dict:
    torch.cuda.synchronize()
    return {**baseline, "peakAllocatedBytes": torch.cuda.max_memory_allocated(),
            "peakReservedBytes": torch.cuda.max_memory_reserved(),
            "remainingAllocatedBytes": torch.cuda.memory_allocated(), "remainingReservedBytes": torch.cuda.memory_reserved()}


def predictor_worker(args) -> None:
    from sdk.protocol.execution import ResourceAllocation, ExecutionIdentity
    from sdk.slave.execution import ExecutionContext, configure_process
    from sdk.process_metrics import ProcessMetrics

    devices = [args.gpu_uuid] if args.device == "cuda" else []
    cpus = psutil.Process().cpu_affinity()[:2]
    allocation = ResourceAllocation(cpu_ids=cpus, cpu_cores=len(cpus), startup_ram_bytes=1024**3,
        ram_available_bytes=2 * 1024**3, gpu_devices=devices, vram_budget_bytes={device: 2 * 1024**3 for device in devices})
    identity = ExecutionIdentity(launcher_id="baseline", boot_id="baseline", instance_id=str(uuid4()),
        job_id=str(uuid4()), attempt_id=str(uuid4()), attempt_count=1, reservation_id=str(uuid4()))
    execution = ExecutionContext(identity, allocation)
    os.environ["CAEMBLE_EXECUTION_JSON"] = json.dumps({"execution_protocol": 3,
        "identity": identity.model_dump(), "allocation": allocation.model_dump()})
    configure_process(execution)
    package = PREDICTOR / "app"
    spec = importlib.util.spec_from_file_location("predictor", package / "__init__.py", submodule_search_locations=[str(package)])
    module = importlib.util.module_from_spec(spec)
    sys.modules["predictor"] = module
    spec.loader.exec_module(module)
    from prediction_contracts import MLP_DEFAULT_ALGORITHM, QUALITY_VALIDATION_V1
    from predictor.execution import ModelExecutionContext
    from predictor.models import ModelBundle
    from predictor.quality import evaluate_quality, split_dataset
    from predictor.storage import ArtifactStore, encode_json
    import numpy as np

    dataset = json.loads(args.dataset.read_text(encoding="utf-8"))
    context = ModelExecutionContext(allocation, 1024**3)
    store = ArtifactStore(args.storage, "baseline-owner", "baseline-launcher")
    result = {"algorithm": args.algorithm, "device": args.device, "allocation": allocation.model_dump()}
    bundle = torch = None
    try:
        if args.worker == "train":
            training, groups, split = split_dataset(dataset)
            algorithm = (deepcopy(MLP_DEFAULT_ALGORITHM) if args.algorithm == "mlp" else
                         {"kind": "knn", "kMode": "auto", "manualK": 1, "weighting": "distance"})
            definition = {"direction": "forward", "algorithm": algorithm, "implementationVersion": args.algorithm + "-v1",
                "preprocessingVersion": "box-relative-v2", "snapshotFingerprint": dataset["fingerprint"],
                "requiredRecordIds": [record["id"] for record in dataset["records"]],
                "qualityValidation": deepcopy(QUALITY_VALIDATION_V1)}
            definition["fingerprint"] = "sha256:" + hashlib.sha256(encode_json(definition)).hexdigest()
            reference = {"modelId": args.model_id, "revision": 1, "operationId": args.model_id, "name": args.model_id}
            with ProcessMetrics(devices) as metrics:
                torch, result["backendInitializationSeconds"] = initialize_backend(args.algorithm, args.device)
                allocator = begin_cuda_memory(torch) if devices else None
                bundle = ModelBundle.prepare(training, "forward", definition, reference, context)
                if devices:
                    result["trainingCudaMemory"] = finish_cuda_memory(torch, allocator)
            result["trainingMetrics"] = metrics.result
            result["trainingTimingIncludesBackendInitialization"] = True
            quality_started = time.perf_counter()
            report = evaluate_quality(bundle, dataset, groups, split, lambda: context)
            result["qualitySeconds"] = time.perf_counter() - quality_started
            bundle.metadata["qualityReport"], bundle.metadata["trainingMetrics"] = report, metrics.result
            save_started = time.perf_counter()
            artifact = bundle.save(store)
            result.update(qualityReport=report, manifestChecksum=artifact["manifestChecksum"],
                          saveSeconds=time.perf_counter() - save_started, definition=definition)
        else:
            with ProcessMetrics(devices) as metrics:
                torch, result["backendInitializationSeconds"] = initialize_backend(args.algorithm, args.device)
                allocator = begin_cuda_memory(torch) if devices else None
                bundle, artifact = ModelBundle.load(store, args.model_id, 1, context)
                if devices:
                    result["loadCudaMemory"] = finish_cuda_memory(torch, allocator)
            result["loadMetrics"] = metrics.result
            result["loadTimingIncludesBackendInitialization"] = True
            queries = [{"direction": "forward", "vars": item["vars"]} for item in dataset["measurements"]]
            # Warm the saved model once; timings below distinguish load and inference.
            expected = [bundle.predict(query, context) for query in queries]
            with ProcessMetrics(devices) as metrics:
                allocator = begin_cuda_memory(torch) if devices else None
                started = time.perf_counter()
                single_iterations = 0
                while single_iterations < 30 or (devices and time.perf_counter() - started < 1):
                    single = [bundle.predict(query, context) for query in queries]
                    single_iterations += 1
                single_seconds = (time.perf_counter() - started) / (single_iterations * len(queries))
                started = time.perf_counter()
                batch_iterations = 0
                while batch_iterations < 30 or (devices and time.perf_counter() - started < 1):
                    batch = (bundle.predict_many(queries, context) if args.algorithm == "mlp"
                             else [bundle.predict(query, context) for query in queries])
                    batch_iterations += 1
                batch_seconds = (time.perf_counter() - started) / batch_iterations
                # A slower OS telemetry query may need more work to finish. This
                # observation tail is excluded from per-call timings above.
                observation_batches = 0
                while devices and metrics.snapshot()["gpuSamples"] == 0 and metrics.snapshot()["elapsedSeconds"] < 5:
                    bundle.predict_many(queries, context)
                    observation_batches += 1
                if devices:
                    result["inferenceCudaMemory"] = finish_cuda_memory(torch, allocator)
            for one, many, warmed in zip(single, batch, expected):
                for left, right, original in zip(one["output"], many["output"], warmed["output"]):
                    assert left["layout"] == right["layout"] == original["layout"]
                    np.testing.assert_allclose(left["values"], right["values"], rtol=2e-5, atol=1e-6)
                    assert np.isfinite(left["values"]).all()
            result.update(inferenceMetrics=metrics.result, meanSingleSeconds=single_seconds,
                meanBatchSeconds=batch_seconds, batchInputs=len(queries), batchMode="native" if args.algorithm == "mlp" else "sequential",
                singleIterations=single_iterations, batchIterations=batch_iterations, observationTailBatches=observation_batches,
                manifestChecksum=artifact["manifestChecksum"], predictions=[item["output"] for item in single])
            if devices and metrics.result["gpuSamples"] < 1:
                raise AssertionError("CUDA inference needs at least one actual process GPU sample.")
    finally:
        if bundle is not None:
            bundle.close()
            result["closed"] = bundle.closed and bundle.persistent_bytes == 0
            if devices and torch is not None:
                result["afterCloseCudaMemory"] = {"allocatedBytes": torch.cuda.memory_allocated(),
                                                  "reservedBytes": torch.cuda.memory_reserved()}
    write_json(args.report, result)


def baseline(args) -> None:
    previous = json.loads(args.reuse_report.read_text(encoding="utf-8")) if args.reuse_report else None
    work = args.report.parent / f"mlp-example-{uuid4().hex}"
    work.mkdir(parents=True)
    report = {"example": "hybrid-box-conductor", "state": "running", "conditionBudgetSeconds": 180,
              "workDirectory": str(work), "conditions": [], "models": [], "productionDatabaseUsed": False,
              "hybridExecuted": False}
    write_json(args.report, report)
    try:
        if previous is None:
            started = time.perf_counter()
            dataset_path = build_dataset(work, report, args.report)
            generation_wall = time.perf_counter() - started
        else:
            if previous.get("example") != "hybrid-box-conductor" or len(previous.get("conditions", [])) != 9:
                raise ValueError("Reuse requires a completed nine-condition Box conductor data-generation report.")
            dataset_path = Path(previous.get("datasetPath", str(Path(previous["workDirectory"]) / "dataset.json")))
            report["conditions"] = deepcopy(previous["conditions"])
            generation_wall = previous.get("dataGeneration", {}).get("wallSeconds")
            provenance = {key: previous[key] for key in ("example", "conditions", "datasetFingerprint", "sourceHash", "measurementCount")}
            write_json(work / "data-generation-source.json", provenance)
            report["reusedDataGenerationReport"] = str(work / "data-generation-source.json")
        dataset = json.loads(dataset_path.read_text(encoding="utf-8"))
        if previous is not None and (dataset["fingerprint"] != previous["datasetFingerprint"] or len(dataset["measurements"]) != 9):
            raise AssertionError("Reused Dataset does not match the original nine-condition generation report.")
        build_seconds = sum(point["build"]["elapsedSeconds"] for point in report["conditions"])
        solve_seconds = sum(point["solve"]["elapsedSeconds"] for point in report["conditions"])
        condition_seconds = sum(point["elapsedSeconds"] for point in report["conditions"])
        report["dataGeneration"] = {"mode": "reused" if previous is not None else "fresh", "conditionCount": 9,
            "buildCommandSeconds": build_seconds, "solverCommandSeconds": solve_seconds,
            "buildAndSolveCommandSeconds": build_seconds + solve_seconds,
            "totalConditionSeconds": condition_seconds, "wallSeconds": generation_wall,
            "notes": "Command timings include child startup and cleanup. totalConditionSeconds sums measured build/solve/record conditions; wallSeconds is null when the original report did not measure final assembly and report I/O."}
        report.update(datasetFingerprint=dataset["fingerprint"], sourceHash=dataset["sourceHash"],
                      measurementCount=len(dataset["measurements"]), datasetPath=str(dataset_path))
        report["measurementNotes"] = [
            "Cold training and load timings include Torch import and device initialization; backendInitializationSeconds reports that subset.",
            "Process-tree RSS/VRAM are sampled OS measurements. Torch CUDA allocator peaks are separate and exclude CUDA context/library memory.",
            "Inference is warmed. Per-call timings use actual iteration counts; any extra telemetry observation tail is excluded."]
        gpu = subprocess.check_output(["nvidia-smi", "--query-gpu=uuid", "--format=csv,noheader"], text=True).splitlines()[0].strip()
        python = PREDICTOR / (".venv/Scripts/python.exe" if os.name == "nt" else ".venv/bin/python")
        storage = work / "models"
        for algorithm, training_device in (("knn", "cpu"), ("mlp", "cpu"), ("mlp", "cuda")):
            model_id = f"{algorithm}-{training_device}"
            record = {"modelId": model_id, "trainingDevice": training_device, "inference": []}
            for mode, device in [("train", training_device), ("infer", training_device),
                                 *(([("infer", "cuda" if training_device == "cpu" else "cpu")]) if algorithm == "mlp" else [])]:
                output = work / f"{model_id}-{mode}-{device}.json"
                process = run_command([str(python), str(Path(__file__).resolve()), "--worker", mode,
                    "--algorithm", algorithm, "--device", device, "--gpu-uuid", gpu,
                    "--dataset", str(dataset_path), "--storage", str(storage), "--model-id", model_id,
                    "--report", str(output)], output.with_suffix(".log"), 180)
                data = json.loads(output.read_text(encoding="utf-8"))
                data["process"] = process
                if mode == "train":
                    record["training"] = data
                else:
                    if data["manifestChecksum"] != record["training"]["manifestChecksum"]:
                        raise AssertionError("Fresh-process inference changed the immutable artifact checksum.")
                    record["inference"].append(data)
            report["models"].append(record)
            write_json(args.report, report)
            print(f"{model_id}: training and fresh-process inference completed", flush=True)
        splits = [model["training"]["qualityReport"]["split"] for model in report["models"]]
        assert all(split == splits[0] for split in splits)
        assert set(splits[0]["trainingMeasurementIds"]).isdisjoint(splits[0]["validationMeasurementIds"])
        for model in report["models"]:
            if len(model["inference"]) == 2:
                import numpy as np
                for first, second in zip(model["inference"][0]["predictions"], model["inference"][1]["predictions"]):
                    for left, right in zip(first, second):
                        assert left["layout"] == right["layout"]
                        np.testing.assert_allclose(left["values"], right["values"], rtol=2e-5, atol=1e-6)
        report.update(state="passed", sharedQualitySplit=splits[0],
                      accuracyPolicy="Advisory comparison on the same held-out designs; no automatic model adoption.",
                      crossDeviceSavedArtifactParity="passed")
    except BaseException as error:
        report.update(state="failed", error=str(error))
        raise
    finally:
        write_json(args.report, report)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=ROOT / ".work/mlp-example-acceptance.json")
    parser.add_argument("--reuse-report", type=Path, help="Reuse the exact nine-condition Dataset from a previous report; rerun Predictor measurements only.")
    parser.add_argument("--worker", choices=("train", "infer"))
    parser.add_argument("--algorithm", choices=("knn", "mlp"))
    parser.add_argument("--device", choices=("cpu", "cuda"))
    parser.add_argument("--gpu-uuid")
    parser.add_argument("--dataset", type=Path)
    parser.add_argument("--storage", type=Path)
    parser.add_argument("--model-id")
    arguments = parser.parse_args()
    if arguments.worker:
        predictor_worker(arguments)
    else:
        baseline(arguments)
