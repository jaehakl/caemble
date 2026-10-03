"""Count successful Solver invocations from persisted Record provenance."""
import math


def hybrid_jobs_cleaned(jobs):
    """A successful prediction may explicitly cancel its disposable Predictor."""
    successful = {job.id: job for job in jobs if job.state == "succeeded"}
    for job in jobs:
        if job.cleaned_at is None:
            return False
        if job.state == "succeeded":
            continue
        binding = (job.artifact_metadata or {}).get("optimization_parent", {})
        parent = successful.get(binding.get("job_id"))
        if (job.state not in {"cancelled", "killed"} or parent is None
                or parent.handler_type != "cae.evaluation.predict" or binding.get("attempt_id") != parent.attempt_id):
            return False
    return True


def recorded_solver_invocations(records, *, measurement_ids, task_names):
    """Invocation ordinals are task-local; multiple Records may share one call."""
    invocations = set()
    for measurement_id, provenance in records:
        task, invocation = provenance.get("task"), provenance.get("invocation")
        if (measurement_id not in measurement_ids or task not in task_names
                or type(invocation) is not int or invocation < 1):
            raise ValueError("Recorded Solver invocation is outside the frozen example.")
        invocations.add((measurement_id, task, invocation))
    for measurement_id in measurement_ids:
        observed = {task for identity, task, _ in invocations if identity == measurement_id}
        if observed != task_names:
            raise ValueError("Every frozen example task must have recorded invocation evidence.")
    return invocations


def recorded_values(tensor):
    assert tensor["storage"]["kind"] == "inline"
    pending, values = [tensor["storage"]["value"]], []
    while pending:
        value = pending.pop()
        if isinstance(value, list):
            pending.extend(reversed(value))
        else:
            assert type(value) in (float, int) and math.isfinite(value)
            values.append(float(value))
    assert len(values) == math.prod(tensor["shape"])
    return values
