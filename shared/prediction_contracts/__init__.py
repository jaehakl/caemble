"""Small, numerical-library-free contracts shared by Prediction participants."""
from __future__ import annotations

from copy import deepcopy
from decimal import Decimal, ROUND_CEILING

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
        "resources": {
            "training": {"gpu_count": 0},
            "inference": {"gpu_count": 0},
        },
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
    if (definition.get("calculationIds") or algorithm.get("calculationWeights")
            or any(key in definition for key in ("targets", "constraints", "objectiveWeights"))):
        raise ValueError("Forward models accept Vars and BoxGrid outputs, without Calculation objectives.")
    return descriptor


def resource_requirements(definition: dict | str, purpose: str) -> dict:
    descriptor = validate_definition(definition) if isinstance(definition, dict) else algorithm_descriptor(definition)
    if purpose not in ("training", "inference"):
        raise ValueError("Prediction resource purpose must be training or inference.")
    return deepcopy(descriptor["resources"][purpose])


def validate_allocation(definition: dict, purpose: str, allocation: dict) -> None:
    required = resource_requirements(definition, purpose)
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
