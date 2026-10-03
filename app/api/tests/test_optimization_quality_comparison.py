"""Comparable held-out errors remain separate from consumer acceptance."""
from copy import deepcopy
import unittest

from optimization.model_updates import compare_quality
from prediction_contracts.quality import assess_quality


class QualityComparisonTests(unittest.TestCase):
    def setUp(self):
        self.previous = {"version": 2, "lineage": {"fingerprint": "lineage", "rootSnapshot": {
            "datasetId": "dataset", "revision": 1, "fingerprint": "root"}}, "records": [{
                "recordId": 10, "status": "evaluated", "unit": "K", "evaluatedMeasurementIds": [5, 6],
                "components": [{"component": "value", "rmse": 0.25}]}]}
        self.current = deepcopy(self.previous)
        self.current["records"][0]["components"][0]["rmse"] = 0.5

    def test_comparable_positive_delta_does_not_reject_an_absolute_limit_pass(self):
        before, after = deepcopy(self.previous), deepcopy(self.current)
        comparison = compare_quality(self.previous, self.current)
        self.assertEqual(comparison, {"lineage_fingerprint": "lineage", "items": [{
            "recordId": 10, "component": "value", "unit": "K", "previous_rmse": 0.25,
            "current_rmse": 0.5, "delta": 0.25}]})
        requirement = [{"recordId": 10, "component": "value", "rmseMaximum": 0.75}]
        self.assertEqual(assess_quality(self.current, requirement)["status"], "passed")
        requirement[0]["rmseMaximum"] = 0.4
        self.assertEqual(assess_quality(self.current, requirement)["status"], "failed")
        self.assertEqual((self.previous, self.current), (before, after))

    def test_missing_old_and_different_lineages_do_not_compare(self):
        for previous, current in ((None, self.current), (self.previous, None),
                ({**self.previous, "version": 1}, self.current),
                ({**self.previous, "version": 1, "lineage": None}, self.current),
                (self.previous, {**self.current, "version": 1}),
                (self.previous, {**self.current, "lineage": {"fingerprint": "another"}})):
            with self.subTest(previous=previous, current=current):
                self.assertIsNone(compare_quality(previous, current))

    def test_compares_only_common_units_components_and_exact_evaluated_cohorts(self):
        for change in ({"unit": "m"}, {"evaluatedMeasurementIds": [5]},
                {"evaluatedMeasurementIds": [5, 7]}, {"status": "unavailable"},
                {"recordId": 11}, {"components": [{"component": "other", "rmse": 0.5}]}):
            with self.subTest(change=change):
                changed = deepcopy(self.current)
                changed["records"][0].update(change)
                comparison = compare_quality(self.previous, changed)
                self.assertFalse(comparison and comparison["items"])
        self.current["records"].append({"recordId": 11, "status": "evaluated", "unit": "K",
            "evaluatedMeasurementIds": [7], "components": [{"component": "value", "rmse": 1}]})
        self.assertEqual(len(compare_quality(self.previous, self.current)["items"]), 1)
