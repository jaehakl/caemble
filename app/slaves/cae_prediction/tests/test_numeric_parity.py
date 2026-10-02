"""Fixed Forward numerical goldens, including dtype rounding and cohort diagnostics."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from predictor.knn import KnnModel


FIXTURE = json.loads(Path(__file__).with_name("forward_reference.json").read_text(encoding="utf-8"))
CASES = [case for case in FIXTURE["cases"] if case["name"].startswith("dtype-")]


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_forward_dtype_and_cohort_goldens(case):
    options = case["options"]
    model = KnnModel.build(options["rows"], fingerprint=case["name"],
                           input_keys=options["inputKeys"], output_keys=options["outputKeys"],
                           algorithm={"kMode": "manual", "manualK": options["k"], "weighting": options["weighting"]},
                           memory_budget=1000000)
    result = model.predict(case["query"])
    assert model.metadata["cohort"]["includedMeasurementIds"] == case["includedMeasurementIds"]
    assert model.metadata["cohort"]["excluded"] == case["excluded"]
    assert len(result["output"]) == len(case["expected"]["output"])
    for actual, expected in zip(result["output"], case["expected"]["output"]):
        assert actual["layout"] == expected["layout"]
        # Quantized outputs must match exactly, including subnormal rounding.
        assert actual["values"] == expected["values"]
    actual_neighbors, expected_neighbors = result["knn"]["neighbors"], case["expected"]["neighbors"]
    assert [row["measurementId"] for row in actual_neighbors] == [row["measurementId"] for row in expected_neighbors]
    for actual, expected in zip(actual_neighbors, expected_neighbors):
        assert actual["weight"] == pytest.approx(expected["weight"], rel=1e-12, abs=1e-12)
        assert actual["distanceSquared"] == pytest.approx(expected["distanceSquared"], rel=1e-12, abs=1e-12)
