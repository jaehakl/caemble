"""Prepare a real saved Predictor model from the E2E server's Solver records."""
import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
from uuid import uuid4

from sqlalchemy import select

from prediction.datasets import freeze_dataset
from prediction.db import DatasetRevision
from prediction.lifecycle import register_storage
from prediction.models import complete_model, reserve_model
from prediction.schemas import DatasetSelection, ModelComplete, ModelReserve, StorageRegistration
from simulation.db import Experiment, ExperimentRecord


async def prepare_hybrid_model(db, *, repo: Path, directory: Path, owner: str,
                                   experiment_id: int, launcher_id: str, storage_root: Path,
                                   vars_schema: dict, rules: list, objects: dict) -> dict:
    """Use the real Dataset/Model services and numerical implementation on local test data."""
    directory.mkdir(parents=True, exist_ok=True)
    experiment = await db.get(Experiment, experiment_id)
    names = {rule["label"] for rule in rules}
    record_ids = list((await db.scalars(select(ExperimentRecord.id).where(
        ExperimentRecord.experiment_id == experiment_id, ExperimentRecord.name.in_(names)))).all())
    dataset = await freeze_dataset(db, DatasetSelection(request_id=uuid4(), name="Hybrid training data",
        experiment_id=experiment_id, source_hash=experiment.source_hash, vars_schema=vars_schema,
        record_ids=record_ids, rules=rules, result_contracts=experiment.result_contracts), owner)
    revision = await db.get(DatasetRevision, (dataset["id"], dataset["current_revision"]))

    def hydrate(value):
        if isinstance(value, dict) and value.get("kind") == "caemble.object":
            prefix = f"caemble/objects/{value['id']}/"
            raw = b"".join(objects[key] for key in sorted(objects) if key.startswith(prefix))
            if len(raw) != value["byteLength"] or hashlib.sha256(raw).hexdigest() != value["sha256"]:
                raise ValueError("Training object does not match its persisted Solver reference.")
            return json.loads(raw) if value["encoding"] == "json" else base64.b64encode(raw).decode("ascii")
        if isinstance(value, dict):
            return {key: hydrate(item) for key, item in value.items()}
        if isinstance(value, list):
            return [hydrate(item) for item in value]
        return value

    payload = hydrate(revision.payload)
    storage_root.mkdir(parents=True, exist_ok=True)
    identity_path = storage_root / "storage-id"
    if not identity_path.exists():
        identity_path.write_text(str(uuid4()), encoding="utf-8")
    storage_id = identity_path.read_text(encoding="utf-8").strip()
    await register_storage(db, StorageRegistration(storage_id=storage_id, launcher_id=launcher_id,
        name="Hybrid E2E Predictor"), owner)
    definition = {"fingerprint": hashlib.sha256((revision.fingerprint + "hybrid-knn").encode()).hexdigest(),
        "snapshotFingerprint": revision.fingerprint, "implementationId": "remote-knn", "implementationVersion": "knn-v1",
        "preprocessingVersion": "box-relative-v2", "algorithm": {"kind": "knn", "kMode": "manual", "manualK": 2, "weighting": "distance"}}
    reserved = await reserve_model(db, ModelReserve(request_id=uuid4(), name="Hybrid E2E kNN", direction="forward",
        dataset_id=dataset["id"], dataset_revision=dataset["current_revision"], definition=definition,
        storage_id=storage_id, launcher_id=launcher_id), owner)
    model = {"modelId": reserved["id"], "revision": reserved["reserved_revision"],
             "operationId": reserved["operation_id"], "name": reserved["name"]}
    input_path, output_path = directory / "knn-input.json", directory / "knn-output.json"
    input_path.write_text(json.dumps({"dataset": payload, "definition": definition, "model": model,
        "storage": str(storage_root), "owner": owner, "launcher": launcher_id}, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    script = directory / "prepare-knn.py"
    script.write_text('''import json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from app.models import ModelBundle
from app.storage import ArtifactStore
value=json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
bundle=ModelBundle.prepare(value["dataset"],"forward",value["definition"],value["model"],256*1024*1024)
artifact=bundle.save(ArtifactStore(Path(value["storage"]),value["owner"],value["launcher"]))
Path(sys.argv[3]).write_text(json.dumps(artifact,allow_nan=False),encoding="utf-8")
''', encoding="utf-8")
    suffix = Path("Scripts/python.exe" if os.name == "nt" else "bin/python")
    python = repo / "app/slaves/cae_prediction/.venv" / suffix
    process = await asyncio.create_subprocess_exec(str(python), str(script), str(repo / "app/slaves/cae_prediction"),
        str(input_path), str(output_path), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        _, stderr = await asyncio.wait_for(process.communicate(), 30)
        if process.returncode != 0:
            raise AssertionError(stderr.decode("utf-8", errors="replace"))
    finally:
        if process.returncode is None:
            process.kill()
        await process.wait()
    artifact = json.loads(output_path.read_text(encoding="utf-8"))
    completed = await complete_model(db, model["modelId"], model["revision"], ModelComplete(
        request_id=model["operationId"], manifest_sha256=artifact["manifestChecksum"], files=artifact["files"],
        profile=artifact["profile"], input_layouts=artifact["inputLayouts"], output_layouts=artifact["outputLayouts"], verified=True), owner)
    saved = next(item for item in completed["revisions"] if item["revision"] == model["revision"])
    replica = next(item for item in saved["replicas"] if item["storage_id"] == storage_id)
    return {"model_id": model["modelId"], "model_revision": model["revision"], "replica_id": replica["id"],
        "launcher_id": launcher_id, "max_solver_runs": 3}
