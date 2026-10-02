"""Count successful Solver invocations from persisted Record provenance."""


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
