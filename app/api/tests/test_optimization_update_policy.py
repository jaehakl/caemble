"""Pure automatic admission and immutable input checks; no Solver or database."""
from copy import deepcopy

import pytest
from pydantic import ValidationError

from optimization.configuration import ModelUpdatePolicy
from optimization.model_update_policy import decide_update


def test_defaults_and_strict_versioned_configuration():
    policy = ModelUpdatePolicy()
    assert policy.model_dump() == {"id": "new_solver_results", "version": 1, "config": {
        "min_new_measurements": 3, "max_updates": 3, "update_timeout_seconds": 180, "total_timeout_seconds": 540}}
    for value in ({"version": True}, {"version": 2}, {"id": "unknown"}, {"config": {"extra": 1}}):
        with pytest.raises(ValidationError):
            ModelUpdatePolicy.model_validate(value)
    for key in type(policy.config).model_fields:
        for invalid in (0, -1, True, "3", 1.5, float("inf")):
            with pytest.raises(ValidationError):
                ModelUpdatePolicy.model_validate({"config": {key: invalid}})


@pytest.mark.parametrize(("change", "reason"), [
    ({"running": False}, "not_running"), ({"next_round": False}, "awaiting_round"),
    ({"busy": True}, "training_busy"), ({"pending_model": True}, "awaiting_adoption"),
    ({"last_request_round": 2}, "round_already_requested"), ({"attempts": 3}, "update_limit"),
    ({"elapsed_seconds": 540}, "time_limit"), ({"new_measurements": 2}, "insufficient_results"),
    ({}, "request"),
])
def test_admission_only_at_available_boundary_with_new_data_and_budget(change, reason):
    inputs = dict(running=True, next_round=True, round_index=2, last_request_round=None,
        busy=False, pending_model=False, new_measurements=3, attempts=0, elapsed_seconds=0)
    inputs.update(change)
    before = deepcopy(inputs)
    decision = decide_update(ModelUpdatePolicy().config, **inputs)
    assert decision.reason == reason
    assert inputs == before
    assert decision.timeout_seconds == (180 if reason == "request" else 0)


def test_remaining_total_limits_next_request_instead_of_resetting_budget():
    decision = decide_update(ModelUpdatePolicy().config, running=True, next_round=True,
        round_index=5, last_request_round=3, busy=False, pending_model=False,
        new_measurements=3, attempts=2, elapsed_seconds=510.5)
    assert (decision.reason, decision.timeout_seconds) == ("request", 29.5)
