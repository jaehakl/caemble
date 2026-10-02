"""Consumer quality decisions need no training, database or numerical libraries."""
from copy import deepcopy
import subprocess
import sys

import pytest

from prediction_contracts import assess_quality, validate_quality_requirements


def report():
    return {"status": "complete", "records": [{"recordId": 7, "key": "temperature", "unit": "K",
        "status": "evaluated", "components": [{"component": "value", "rmse": 0.5}]}]}


def test_equal_limit_passes_without_mutating_report_or_requirements():
    evidence = report()
    requirements = [{"recordId": 7, "component": "value", "rmseMaximum": 0.5}]
    original = deepcopy((evidence, requirements))
    decision = assess_quality(evidence, requirements)
    assert decision == {"status": "passed", "reasonCode": "requirements-passed", "items": [{
        **requirements[0], "status": "passed", "reasonCode": "within-limit", "rmse": 0.5, "unit": "K"}]}
    assert (evidence, requirements) == original
    assert assess_quality(evidence, requirements) == decision


def test_exceeded_limit_fails_and_partial_report_can_pass_requested_output():
    evidence = report()
    evidence["status"] = "partial"
    evidence["records"].append({"recordId": 8, "status": "unavailable", "components": []})
    requirements = [{"recordId": 7, "component": "value", "rmseMaximum": 0.6}]
    assert assess_quality(evidence, requirements)["status"] == "passed"
    requirements[0]["rmseMaximum"] = 0.4
    decision = assess_quality(evidence, requirements)
    assert decision["status"] == "failed"
    assert decision["items"][0]["reasonCode"] == "rmse-exceeded"


@pytest.mark.parametrize("change,reason", [
    ("report", "report-unavailable"), ("record", "record-unavailable"),
    ("status", "record-unavailable"), ("component", "component-unavailable"),
    ("nan", "invalid-rmse"), ("negative", "invalid-rmse"), ("boolean", "invalid-rmse"),
])
def test_missing_or_unusable_required_metric_is_unassessed(change, reason):
    evidence = report()
    if change == "report":
        evidence = None
    elif change == "record":
        evidence["records"] = []
    elif change == "status":
        evidence["records"][0]["status"] = "unavailable"
    elif change == "component":
        evidence["records"][0]["components"] = []
    else:
        evidence["records"][0]["components"][0]["rmse"] = {"nan": float("nan"), "negative": -1, "boolean": True}[change]
    decision = assess_quality(evidence, [{"recordId": 7, "component": "value", "rmseMaximum": 0.5}])
    assert decision["status"] == "unassessed"
    assert decision["items"][0]["reasonCode"] == reason


def test_missing_evidence_precedes_failure_and_absent_limits_never_mean_passed():
    requirements = [{"recordId": 7, "component": "value", "rmseMaximum": 0},
                    {"recordId": 8, "component": "value", "rmseMaximum": 0}]
    result = assess_quality(report(), requirements)
    assert result["status"] == "unassessed"
    assert [item["status"] for item in result["items"]] == ["failed", "unassessed"]
    assert assess_quality(report(), None) == {
        "status": "unassessed", "reasonCode": "requirements-not-configured", "items": []}


@pytest.mark.parametrize("requirements", [[], {}, [{"recordId": 0, "component": "value", "rmseMaximum": 1}],
    [{"recordId": 7, "component": " ", "rmseMaximum": 1}],
    [{"recordId": 7, "component": "value", "rmseMaximum": float("inf")}],
    [{"recordId": 7, "component": "value", "rmseMaximum": -1}],
    [{"recordId": True, "component": "value", "rmseMaximum": 1}],
    [{"recordId": 7, "component": "value", "rmseMaximum": 1}] * 2])
def test_invalid_requirements_are_input_errors(requirements):
    with pytest.raises(ValueError):
        validate_quality_requirements(requirements)


def test_shared_import_does_not_load_worker_database_or_numerical_packages():
    subprocess.run([sys.executable, "-c", "import sys; from prediction_contracts import assess_quality; "
        "assert not any(name in sys.modules for name in ('torch', 'numpy', 'sqlalchemy', 'httpx'))"], check=True)
