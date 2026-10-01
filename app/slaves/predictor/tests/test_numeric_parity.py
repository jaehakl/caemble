"""Browser-generated dtype/cohort fixtures plus the supported Calculation boundary."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from predictor.errors import PredictionError
from predictor.knn import KnnModel
from predictor.models import calculation_sample
from predictor.runtime import PredictorRuntime
from .fixtures import dataset, definition, stage


FIXTURE = json.loads(Path(__file__).with_name("browser_reference.json").read_text(encoding="utf-8"))
CASES = [case for case in FIXTURE["cases"] if case["name"].startswith(("dtype-", "strict-calculation-"))]


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_browser_dtype_and_cohort_parity(case):
    options = case["options"]
    model = KnnModel.build(options["rows"], direction=options["direction"], fingerprint=case["name"],
                           input_keys=options["inputKeys"], output_keys=options["outputKeys"],
                           algorithm={"kMode": "manual", "manualK": options["k"], "weighting": options["weighting"]},
                           memory_budget=1000000)
    result = model.predict(case["query"])
    assert model.metadata["cohort"]["includedMeasurementIds"] == case["includedMeasurementIds"]
    assert model.metadata["cohort"]["excluded"] == case["excluded"]
    assert len(result["output"]) == len(case["expected"]["output"])
    for actual, expected in zip(result["output"], case["expected"]["output"]):
        assert actual["layout"] == expected["layout"]
        if options["direction"] == "forward" or actual["layout"]["dtype"] == "complex64":
            # Quantized outputs must match exactly, including subnormal rounding.
            assert actual["values"] == expected["values"]
        else:
            assert actual["values"] == pytest.approx(expected["values"], rel=1e-12, abs=1e-12)
    actual_neighbors, expected_neighbors = result["knn"]["neighbors"], case["expected"]["neighbors"]
    assert [row["measurementId"] for row in actual_neighbors] == [row["measurementId"] for row in expected_neighbors]
    for actual, expected in zip(actual_neighbors, expected_neighbors):
        assert actual["weight"] == pytest.approx(expected["weight"], rel=1e-12, abs=1e-12)
        assert actual["distanceSquared"] == pytest.approx(expected["distanceSquared"], rel=1e-12, abs=1e-12)


@pytest.mark.parametrize("dtype,value", [("complex64", {"re": 10, "im": 1}), ("float16", 10), ("int64", 10), ("uint64", 10)])
def test_calculation_rejects_dtypes_outside_current_calculation_contract(dtype, value):
    with pytest.raises(PredictionError, match="unsupported output dtype"):
        calculation_sample(4, {"dtype": dtype, "shape": [], "axes": [], "data": value})


def test_complex_calculation_cannot_create_a_saved_inverse_model(tmp_path):
    manifest = dataset()
    manifest["calculations"][0]["output_layout"]["dtype"] = "complex64"
    for record in manifest["calculationData"]:
        record["data"].update(dtype="complex64", data={"re": record["data"]["data"], "im": 1})
    runtime = PredictorRuntime(tmp_path, "owner", "launcher", "http://127.0.0.1", 1000000)
    reference = stage(runtime, manifest)
    with pytest.raises(PredictionError) as error:
        runtime.dispatch("model.prepare", {"protocolVersion": 2, "requestId": "complex-unsupported", "sessionId": runtime.session_id,
            "dataset": reference, "direction": "inverse", "definition": definition(manifest),
            "model": {"modelId": "unsupported-complex", "revision": 1, "operationId": "prepare", "name": "Unsupported"}})
    assert error.value.code == "insufficient-cohort"
    assert runtime.store.list("models") == []
