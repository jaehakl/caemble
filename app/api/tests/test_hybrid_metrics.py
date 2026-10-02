"""Low-cost regression for thermal demo's task-local Solver call accounting."""
import pytest

from hybrid_metrics_fixture import recorded_solver_invocations


def test_distinct_tasks_and_measurements_count_but_duplicate_records_do_not():
    rows = [(measurement_id, {"task": task, "invocation": 1})
        for measurement_id in (10, 11) for task in ("electric", "thermal") for _ in range(2)]
    result = recorded_solver_invocations(rows, measurement_ids={10, 11}, task_names={"electric", "thermal"})
    assert result == {(10, "electric", 1), (10, "thermal", 1), (11, "electric", 1), (11, "thermal", 1)}


def test_missing_frozen_task_cannot_be_reported_as_complete():
    with pytest.raises(ValueError, match="Every frozen"):
        recorded_solver_invocations([(10, {"task": "electric", "invocation": 1})],
            measurement_ids={10}, task_names={"electric", "thermal"})
