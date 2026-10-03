"""Small, numerical-library-free contracts shared by Prediction participants."""
from __future__ import annotations

from copy import deepcopy
from decimal import Decimal, ROUND_CEILING
import re

from .quality import (QUALITY_VALIDATION_V1, QUALITY_VALIDATION_V2, assess_quality, validate_quality_lineage,
                      validate_quality_report, validate_quality_requirements, validate_quality_settings,
                      validate_quality_update)
from .mlp import MLP_DEFAULT_ALGORITHM, validate_mlp_algorithm

PREDICTION_PROTOCOL_VERSION = 3
EXECUTION_ID = "remote-predictor"

ALGORITHMS = {
    "knn": {
        "kind": "knn",
        "implementationVersion": "knn-v1",
        "preprocessingVersion": "box-relative-v2",
        "directions": ["forward"],
        "representations": ["box-relative-v2"],
        "supportsCheckpoints": False,
        "supportsNativeBatch": False,
        "supportedUpdateModes": ["rebuild"],
        "resources": {
            "training": {"gpu_count": 0},
            "inference": {"gpu_count": 0},
        },
    },
    "mlp": {
        "kind": "mlp",
        "implementationVersion": "mlp-v1",
        "preprocessingVersion": "box-relative-v2",
        "directions": ["forward"],
        "representations": ["box-relative-v2"],
        "supportsCheckpoints": False,
        "supportsNativeBatch": True,
        "supportedUpdateModes": ["rebuild"],
        "resources": {"training": {"gpu_count": 1}, "inference": {"gpu_count": 1}},
        "cpuFallbackResources": {"training": {"gpu_count": 0}, "inference": {"gpu_count": 0}},
    },
}


def algorithm_descriptor(definition_or_kind: dict | str) -> dict:
    if isinstance(definition_or_kind, dict):
        algorithm = definition_or_kind.get("algorithm")
        kind = algorithm.get("kind") if isinstance(algorithm, dict) else None
    else:
        kind = definition_or_kind
    if not isinstance(kind, str) or kind not in ALGORITHMS:
        raise ValueError("Unsupported Forward model algorithm.")
    return deepcopy(ALGORITHMS[kind])


def validate_definition(definition: dict) -> dict:
    if not isinstance(definition, dict):
        raise ValueError("Model definition must be an object.")
    descriptor = algorithm_descriptor(definition)
    if definition.get("direction", "forward") not in descriptor["directions"]:
        raise ValueError("Only Forward Vars-to-BoxGrid models execute.")
    if any(definition.get(key) != descriptor[key] for key in ("implementationVersion", "preprocessingVersion")):
        raise ValueError("Model implementation or preprocessing version is not supported.")
    algorithm = definition["algorithm"]
    if descriptor["kind"] == "mlp":
        validate_mlp_algorithm(algorithm)
    validate_quality_settings(definition.get("qualityValidation"))
    if (definition.get("calculationIds") or algorithm.get("calculationWeights")
            or any(key in definition for key in ("targets", "constraints", "objectiveWeights"))):
        raise ValueError("Forward models accept Vars and BoxGrid outputs, without Calculation objectives.")
    return descriptor


def resource_requirements(definition: dict | str, purpose: str, *, configured_gpu_count: int | None = None) -> dict:
    descriptor = validate_definition(definition) if isinstance(definition, dict) else algorithm_descriptor(definition)
    if purpose not in ("training", "inference"):
        raise ValueError("Prediction resource purpose must be training or inference.")
    profiles = descriptor["resources"]
    if type(configured_gpu_count) is int and configured_gpu_count == 0:
        profiles = descriptor.get("cpuFallbackResources", profiles)
    return deepcopy(profiles[purpose])


def validate_training_update(update: dict | None, definition: dict) -> str:
    """Validate a new immutable training request, independently of checkpoint resume."""
    descriptor = validate_definition(definition)
    if update is None:
        return "rebuild"
    if not isinstance(update, dict) or update.get("mode") not in descriptor["supportedUpdateModes"]:
        raise ValueError("This algorithm does not support the requested training update mode.")
    mode = update["mode"]
    if definition.get("qualityValidation") is not None and mode != "rebuild":
        raise ValueError("Quality validation requires rebuild; continued-weight validation is not supported.")
    target = update.get("targetSnapshot")
    if (not isinstance(target, dict) or not isinstance(target.get("datasetId"), str) or not target["datasetId"]
            or type(target.get("revision")) is not int or target["revision"] < 1
            or not isinstance(target.get("fingerprint"), str) or not target["fingerprint"]
            or target.get("fingerprint") != definition.get("snapshotFingerprint")):
        raise ValueError("Training update must identify its exact target snapshot.")
    base = update.get("baseModel")
    if base is not None:
        if (not isinstance(base, dict) or any(not isinstance(base.get(key), str) or not base[key]
                for key in ("modelId", "storageId", "replicaId"))
                or type(base.get("revision")) is not int or base["revision"] < 1
                or not isinstance(base.get("checksum"), str) or not re.fullmatch(r"[0-9a-f]{64}", base["checksum"])):
            raise ValueError("Training update must identify an exact checksummed base model copy.")
    elif mode != "rebuild":
        raise ValueError("Warm-start and incremental training require a completed base model.")
    changes = update.get("changeSet")
    if not isinstance(changes, dict) or changes.get("targetSnapshot") != target:
        raise ValueError("Training changes must belong to the target snapshot.")
    before = changes.get("baseSnapshot")
    if base is not None and (not isinstance(before, dict) or not isinstance(before.get("datasetId"), str)
            or type(before.get("revision")) is not int or before["revision"] < 1
            or not isinstance(before.get("fingerprint"), str)):
        raise ValueError("Training changes must identify the base snapshot.")
    seen = set()
    for key in ("added", "changed", "removed"):
        identities = changes.get(key)
        if (not isinstance(identities, list) or any(type(identity) is not int or identity < 1 for identity in identities)
                or len(set(identities)) != len(identities) or seen.intersection(identities)):
            raise ValueError("Training changes require distinct added, changed and removed Measurement IDs.")
        seen.update(identities)
    if mode == "incremental" and (changes["changed"] or changes["removed"]):
        raise ValueError("Incremental training supports added samples only; use rebuild for corrections or removals.")
    if not isinstance(update.get("recipe"), dict):
        raise ValueError("Training update recipe must be a frozen object.")
    return mode


def validate_new_training(definition: dict, update: dict | None = None) -> str:
    """New operations use v2 quality; legacy definitions remain readable for inference."""
    mode = validate_training_update(update, definition)
    if (definition.get("qualityValidation") or {}).get("version") == 1:
        raise ValueError("New quality training requires version 2; create a fresh model instead.")
    return mode


def validate_allocation(definition: dict, purpose: str, allocation: dict) -> None:
    # The trusted Launcher allocation determines the backend for this process.
    required = resource_requirements(definition, purpose, configured_gpu_count=len(allocation.get("gpu_devices", [])))
    required.setdefault("cpu_cores", 1)
    for key in ("cpu_cores", "startup_ram_bytes"):
        if allocation.get(key, 0) < required.get(key, 0):
            raise ValueError(f"Prediction allocation does not satisfy {key}.")
    if required.get("vram_budget_gb") is not None:
        budget = int((Decimal(str(required["vram_budget_gb"])) * 1024**3).to_integral_value(rounding=ROUND_CEILING))
        if any(allocation.get("vram_budget_bytes", {}).get(device, 0) < budget
               for device in allocation.get("gpu_devices", [])):
            raise ValueError("Prediction allocation does not satisfy vram_budget_gb.")
    if len(allocation.get("gpu_devices", [])) < required.get("gpu_count", 0):
        raise ValueError("Prediction allocation does not satisfy its GPU requirement.")
