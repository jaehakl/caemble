"""Low-cost regression for thermal demo's task-local Solver call accounting."""
import pytest
from types import SimpleNamespace

from hybrid_metrics_fixture import hybrid_jobs_cleaned, recorded_solver_invocations


@pytest.mark.parametrize("change,expected", [({}, True), ({"cleaned_at": None}, False),
    ({"state": "failed"}, False), ({"artifact_metadata": {}}, False),
    ({"artifact_metadata": {"optimization_parent": {"job_id": "parent", "attempt_id": "old"}}}, False)])
def test_predictor_cleanup_cancellation_requires_successful_matching_parent(change, expected):
    parent = SimpleNamespace(id="parent", state="succeeded", cleaned_at="done", artifact_metadata={},
        handler_type="cae.evaluation.predict", attempt_id="attempt")
    child = SimpleNamespace(**{"id": "child", "state": "cancelled", "cleaned_at": "done",
        "artifact_metadata": {"optimization_parent": {"job_id": "parent", "attempt_id": "attempt"}}, **change})
    assert hybrid_jobs_cleaned([parent, child]) is expected
    parent.state = "failed"
    assert not hybrid_jobs_cleaned([parent, child])


def test_distinct_tasks_and_measurements_count_but_duplicate_records_do_not():
    rows = [(measurement_id, {"task": task, "invocation": 1})
        for measurement_id in (10, 11) for task in ("electric", "thermal") for _ in range(2)]
    result = recorded_solver_invocations(rows, measurement_ids={10, 11}, task_names={"electric", "thermal"})
    assert result == {(10, "electric", 1), (10, "thermal", 1), (11, "electric", 1), (11, "thermal", 1)}


def test_missing_frozen_task_cannot_be_reported_as_complete():
    with pytest.raises(ValueError, match="Every frozen"):
        recorded_solver_invocations([(10, {"task": "electric", "invocation": 1})],
            measurement_ids={10}, task_names={"electric", "thermal"})
