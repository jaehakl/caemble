"""Train a saved Predictor through its server-owned Job using real Solver records."""
import asyncio
from copy import deepcopy
import hashlib
from pathlib import Path
from uuid import uuid4

from sqlalchemy import select
from prediction_contracts import MLP_DEFAULT_ALGORITHM, QUALITY_VALIDATION_V1

from gpstation.db import Job
from prediction import training
from prediction.datasets import freeze_dataset
from prediction.db import DatasetRevision, ModelRevision, Operation, Replica, TrainingRun
from prediction.lifecycle import register_storage
from prediction.models import reserve_model
from prediction.schemas import DatasetSelection, ModelReserve, StorageRegistration
from simulation.db import Experiment, ExperimentRecord


async def prepare_hybrid_model(sessions, *, owner: str, experiment_id: int,
                               launcher_id: str, storage_root: Path, vars_schema: dict,
                               rules: list, report: dict, algorithm: str = "knn",
                               measurement_count: int = 3) -> dict:
    """The caller's single flow deadline also bounds Dataset preparation and training."""
    async with sessions() as db:
        experiment = await db.get(Experiment, experiment_id)
        names = {rule["label"] for rule in rules}
        record_ids = list((await db.scalars(select(ExperimentRecord.id).where(
            ExperimentRecord.experiment_id == experiment_id, ExperimentRecord.name.in_(names)))).all())
        dataset = await freeze_dataset(db, DatasetSelection(request_id=uuid4(), name="Hybrid training data",
            experiment_id=experiment_id, source_hash=experiment.source_hash, vars_schema=vars_schema,
            record_ids=record_ids, rules=rules, result_contracts=experiment.result_contracts), owner)
        revision = await db.get(DatasetRevision, (dataset["id"], dataset["current_revision"]))
        assert len(revision.payload["measurements"]) == measurement_count
        assert revision.payload["calculations"] == revision.payload["calculationData"] == []

        # Only the local storage identity is fixture setup. The worker downloads
        # the immutable server Dataset with the actual attempt-scoped grant.
        storage_root.mkdir(parents=True, exist_ok=True)
        storage_id = str(uuid4())
        (storage_root / "storage-id").write_text(storage_id, encoding="utf-8")
        await register_storage(db, StorageRegistration(storage_id=storage_id, launcher_id=launcher_id,
            name="Hybrid E2E Predictor"), owner)
        definition = {"fingerprint": hashlib.sha256((revision.fingerprint + "hybrid-" + algorithm).encode()).hexdigest(),
            "snapshotFingerprint": revision.fingerprint, "implementationId": "remote-predictor", "implementationVersion": f"{algorithm}-v1",
            "preprocessingVersion": "box-relative-v2", "algorithm": {"kind": "knn", "kMode": "manual", "manualK": 2, "weighting": "distance"}}
        if algorithm == "mlp":
            definition.update(algorithm=deepcopy(MLP_DEFAULT_ALGORITHM),
                qualityValidation=deepcopy(QUALITY_VALIDATION_V1), requiredRecordIds=sorted(record_ids))
        reserved = await reserve_model(db, ModelReserve(request_id=uuid4(), name=f"Hybrid E2E {algorithm}", direction="forward",
            dataset_id=dataset["id"], dataset_revision=dataset["current_revision"], definition=definition,
            storage_id=storage_id, launcher_id=launcher_id), owner)
        model_id, model_revision = reserved["id"], reserved["reserved_revision"]
        operation_id = reserved["operation_id"]
        report["model_training"] = {"operation_id": operation_id, "model_id": model_id,
            "model_revision": model_revision, "dataset_id": dataset["id"],
            "dataset_revision": dataset["current_revision"], "source_kind": reserved["training"]["sourceKind"],
            "dataset_fingerprint": revision.fingerprint, "definition": definition, "record_ids": sorted(record_ids),
            "dataset_measurement_ids": [item["id"] for item in revision.payload["measurements"]],
            "design_points": [{"id": item["id"], "vars": item["vars"]} for item in revision.payload["measurements"]]}
        assert reserved["training"]["sourceKind"] == "api"
        submitted = await training.submit(db, operation_id, owner)
        job_id = submitted["training"]["jobId"]
        report["model_training"]["job_id"] = job_id

    while True:
        async with sessions() as db:
            job = await db.get(Job, job_id)
            operation = await db.get(Operation, operation_id)
            report["model_training"].update(state=job.state, cleaned=job.cleaned_at is not None)
            assert job.state not in {"failed", "cancelled", "killed", "rejected"}, job.last_error
            assert operation.state not in {"failed", "cancelled"}, operation.error
            if job.state == "succeeded" and job.cleaned_at is not None:
                assert job.slave_app_id == "predictor-training" and job.handler_type == "prediction.train"
                assert job.started_at is not None
                run = await db.get(TrainingRun, operation_id)
                saved = await db.get(ModelRevision, (model_id, model_revision))
                replica = await db.scalar(select(Replica).where(Replica.model_id == model_id,
                    Replica.revision == model_revision, Replica.storage_id == storage_id))
                assert run.job_id == job_id and run.source_kind == "api"
                assert operation.state == "completed" and saved.state == "ready"
                assert replica is not None and replica.state == "present"
                assert saved.definition == definition
                assert len(saved.artifact["manifest_sha256"]) == 64
                # Match the application's cleanup sweep, after the Launcher has
                # authoritatively confirmed the training process tree exited.
                await training.reconcile(db)
                report["model_training"].update(checksum=saved.artifact["manifest_sha256"],
                    duration_seconds=(job.finished_at - job.started_at).total_seconds(),
                    cleaned_at=job.cleaned_at.isoformat(), replica_id=replica.id,
                    quality_report=saved.artifact.get("quality_report"),
                    training_metrics=saved.artifact.get("training_metrics"),
                    execution_metrics=saved.artifact.get("execution_metrics"))
                split = (saved.artifact.get("quality_report") or {}).get("split", {})
                report["model_training"].update(
                    training_measurement_ids=split.get("trainingMeasurementIds", report["model_training"]["dataset_measurement_ids"]),
                    validation_measurement_ids=split.get("validationMeasurementIds", []))
                return {"model_id": model_id, "model_revision": model_revision, "replica_id": replica.id,
                    "launcher_id": launcher_id, "max_solver_runs": 3}
        await asyncio.sleep(0.1)
