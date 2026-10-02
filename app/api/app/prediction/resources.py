"""Resolve Predictor requirements against configured Launcher defaults, not load."""
from gpstation.service.execution import requested_resources
from prediction_contracts import resource_requirements


def resolve_resources(definition: dict | str, purpose: str, report: dict, *, default_cpu_cores: int | None = None) -> dict:
    if purpose not in ("training", "inference"):
        raise ValueError("Prediction resource purpose must be training or inference.")
    app_id, handler = (("predictor-training", "prediction.train") if purpose == "training"
                       else ("predictor", "predictor.hello"))
    configured = requested_resources({}, report, app_id, handler)
    required = resource_requirements(definition, purpose, configured_gpu_count=configured.get("gpu_count"))
    if default_cpu_cores is not None:
        required = {"cpu_cores": default_cpu_cores, **required}
    # A missing VRAM budget keeps the existing whole-device reservation policy.
    return requested_resources(required, report, app_id, handler)
