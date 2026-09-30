import math
import unittest
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from optimization.algorithm import coordinate_candidates, evaluate_metrics, next_round, prepare_axes, variables_fingerprint


class OptimizationAlgorithmTests(unittest.TestCase):
    def test_all_tensor_elements_and_fixed_overrides(self):
        schema = {"matrix": {"shape": [2, 2], "min": 0, "max": 1}, "scalar": {"shape": [], "min": 0, "max": 2}}
        variables = {"matrix": [[0.5, 0.5], [0.5, 0.5]], "scalar": 1}
        axes = prepare_axes(schema, variables, [{"name": "matrix", "indices": [1, 0], "fixed": True}])
        self.assertEqual(len(axes), 5)
        candidates = list(coordinate_candidates(variables, axes, 0.25))
        self.assertEqual(len(candidates), 8)
        self.assertTrue(all(value["matrix"][1][0] == 0.5 for value, _ in candidates))
        self.assertEqual(variables_fingerprint({"x": 1}), variables_fingerprint({"x": 1.0}))

    def test_constraints_are_not_evaluation_failures(self):
        settings = {"constraints": [{"key": "constraint:0", "minimum": 2, "maximum": 4}]}
        result = evaluate_metrics([{"key": "objective", "value": 9}, {"key": "constraint:0", "value": 1}], settings)
        self.assertFalse(result["feasible"])
        self.assertEqual(result["violation"], 0.25)

    def test_fixed_axes_still_require_initial_values_inside_search_bounds(self):
        schema = {"x": {"shape": [], "min": 0, "max": 1}}
        for override in ({"min": 0.5, "max": 0.5}, {"min": 0.5, "fixed": True}):
            with self.subTest(override=override), self.assertRaisesRegex(ValueError, "outside its search range"):
                prepare_axes(schema, {"x": 0.2}, [{"name": "x", **override}])
        axes = prepare_axes(schema, {"x": 0.5}, [{"name": "x", "min": 0.5, "max": 0.5}])
        self.assertTrue(axes[0]["fixed"])
        self.assertEqual(list(coordinate_candidates({"x": 0.5}, axes, 0.25)), [])

    def test_extreme_finite_range_preserves_quarter_step_and_clips_at_bounds(self):
        schema = {"x": {"shape": [], "min": -1.7e308, "max": 1.7e308}}
        axes = prepare_axes(schema, {"x": 0})
        candidates = list(coordinate_candidates({"x": 0}, axes, 0.25))
        self.assertEqual([value["x"] for value, _ in candidates], [8.5e307, -8.5e307])
        candidates = list(coordinate_candidates({"x": 1.7e308}, axes, 0.25))
        self.assertEqual([value["x"] for value, _ in candidates], [8.5e307])
        self.assertTrue(all(math.isfinite(value["x"]) for value, _ in candidates))

    def test_extreme_finite_constraint_distance_is_normalized_before_subtraction(self):
        for constraint, value in (({"minimum": 1e308}, -1e308), ({"maximum": -1e308}, 1e308)):
            with self.subTest(constraint=constraint):
                result = evaluate_metrics(
                    [{"key": "objective", "value": 9}, {"key": "constraint:0", "value": value}],
                    {"constraints": [{"key": "constraint:0", **constraint}]},
                )
                self.assertFalse(result["feasible"])
                self.assertEqual(result["violation"], 2)

    def test_constraint_feasibility_does_not_depend_on_normalized_underflow(self):
        result = evaluate_metrics(
            [{"key": "objective", "value": 9}, {"key": "constraint:0", "value": 0}],
            {"constraints": [{"key": "constraint:0", "minimum": 1e-100, "maximum": 1e308}]},
        )
        self.assertFalse(result["feasible"])
        self.assertFalse(result["constraints"][0]["satisfied"])
        self.assertTrue(math.isfinite(result["violation"]))

    def test_aggregate_constraint_overflow_fails_before_persistence(self):
        with self.assertRaisesRegex(ValueError, "Aggregate constraint violation must be finite"):
            evaluate_metrics(
                [{"key": "objective", "value": 9}, *[{"key": f"constraint:{index}", "value": 1e308} for index in range(2)]],
                {"constraints": [{"key": f"constraint:{index}", "maximum": 0} for index in range(2)]},
            )

    def test_rounds_budget_and_completion_order(self):
        settings = {"initial_vars": {"x": 0.5}, "axes": prepare_axes({"x": {"shape": [], "min": 0, "max": 1}}, {"x": 0.5}),
                    "objective": {"direction": "maximize"}, "max_trials": 5, "constraints": []}
        state, definitions, done = next_round([], settings, {})
        trials = []
        while not done:
            for definition in definitions:
                trials.append(SimpleNamespace(id=str(definition["ordinal"]), **definition, state="succeeded",
                                              result={"objective": definition["variables"]["x"], "feasible": True, "violation": 0}))
            state, definitions, done = next_round(list(reversed(trials)), settings, state)
        self.assertLessEqual(len(trials), 5)
        self.assertEqual(max(trial.result["objective"] for trial in trials), 1)
        self.assertEqual(len({trial.fingerprint for trial in trials}), len(trials))

    def test_failed_round_waits_for_explicit_retry(self):
        trial = SimpleNamespace(id="1", ordinal=1, state="failed")
        state, candidates, done = next_round([trial], {"initial_step": .25}, {})
        self.assertFalse(done)
        self.assertEqual(candidates, [])


if __name__ == "__main__":
    unittest.main()
