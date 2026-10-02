"""Pure Hybrid policy regression checks; no API, DB, Predictor or Solver runtime."""
from copy import deepcopy
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from optimization.algorithm import prepare_axes, variables_fingerprint
from optimization.search import advance_search, generate_coordinate_round, select_verifications


class HybridSelectionTests(unittest.TestCase):
    def test_feasible_best_and_normalized_maximin_exploration_with_ordinal_ties(self):
        axes = [{"name": "x", "indices": [], "min": 0, "max": 100, "fixed": False},
                {"name": "y", "indices": [], "min": 0, "max": 1, "fixed": False}]
        trials = [SimpleNamespace(id=str(n), ordinal=n, variables={"x": x, "y": y})
                  for n, x, y in [(1, 0, 0), (2, 1, 0), (3, 50, 1), (4, 50, 1), (5, 90, 0)]]
        predictions = {trial.id: SimpleNamespace(result={"objective": trial.ordinal, "feasible": True, "violation": 0}) for trial in trials}
        predictions["1"].result = {"objective": -100, "feasible": False, "violation": 1}
        verified = [SimpleNamespace(variables={"x": 100, "y": 0})]
        self.assertEqual(select_verifications(trials, predictions, verified, axes, "minimize", 2), ["2", "3"])
        self.assertEqual(select_verifications(trials, predictions, verified, axes, "minimize", 1), ["2"])
        self.assertEqual(select_verifications(trials, predictions, verified, axes, "minimize", 0), [])

    def test_candidate_limit_reuses_unverified_predictions_without_moving_to_predicted_center(self):
        trials = [SimpleNamespace(id=str(n), ordinal=n, round_index=0, variables={"x": [x]}, fingerprint=str(n))
                  for n, x in [(1, 4), (2, 9), (3, 1)]]
        evaluations = [SimpleNamespace(trial_id=trial.id, kind="prediction", state="succeeded",
                      result={"objective": -trial.ordinal, "feasible": True, "violation": 0}) for trial in trials]
        evaluations.append(SimpleNamespace(trial_id="1", kind="solver", state="succeeded",
                           result={"objective": 10, "feasible": True, "violation": 0}))
        settings = {"initial_vars": {"x": [4]}, "initial_step": 0.25, "min_step": 0.001, "max_trials": 3,
                    "objective": {"direction": "minimize"}, "axes": [{"name": "x", "indices": [0], "min": 0, "max": 10, "fixed": False}]}
        state, generated, selected, reason = advance_search(trials, evaluations, settings,
            {"round_ordinals": [1], "selection": ["1"], "round_index": 0}, {"remaining": 2})
        self.assertEqual((generated, selected, reason), ([], ["3", "2"], None))
        self.assertEqual(state["incumbent_ordinal"], 1)
        self.assertEqual(state["selections"][-1]["trial_ids"], selected)


class HybridSearchTests(unittest.TestCase):
    def setUp(self):
        self.settings = {
            "initial_vars": {"x": 0.5}, "initial_step": 0.25, "min_step": 0.001, "max_trials": 8,
            "objective": {"direction": "minimize"},
            "axes": prepare_axes({"x": {"shape": [], "min": 0, "max": 1}}, {"x": 0.5}),
        }

    def trial(self, ordinal, value):
        return SimpleNamespace(id=str(ordinal), ordinal=ordinal, round_index=0,
                               variables={"x": value}, fingerprint=variables_fingerprint({"x": value}))

    def evaluation(self, trial, kind, objective, state="succeeded"):
        return SimpleNamespace(trial_id=trial.id, kind=kind, state=state,
                               result={"objective": objective, "feasible": True, "violation": 0})

    def test_multiple_rounds_preserve_history_and_resume_from_json(self):
        def run(resume):
            trials, evaluations, trace = [], [], []
            state = {"runtime_id": "saved-runtime", "future_metadata": {"values": [1, 2]}}
            for _ in range(30):
                if resume:
                    state = json.loads(json.dumps(state))
                    trials = [SimpleNamespace(**json.loads(json.dumps(vars(item)))) for item in reversed(trials)]
                    evaluations = [SimpleNamespace(**json.loads(json.dumps(vars(item)))) for item in reversed(evaluations)]
                used = sum(item.kind == "solver" for item in evaluations)
                budget = {"limit": 10, "used": used, "reserved": 0, "remaining": 10 - used}
                inputs = (trials, evaluations, self.settings, state, budget)
                snapshot = deepcopy(inputs)
                state, generated, selected, reason = advance_search(*inputs)
                self.assertEqual(inputs, snapshot)
                self.assertEqual(state["runtime_id"], "saved-runtime")
                self.assertEqual(state["future_metadata"], {"values": [1, 2]})
                trace.append(deepcopy((state, generated, selected, reason)))
                for candidate in generated:
                    trial = SimpleNamespace(id=str(candidate["ordinal"]), **candidate)
                    trials.append(trial)
                    evaluations.append(self.evaluation(trial, "prediction", -trial.variables["x"]))
                by_id = {trial.id: trial for trial in trials}
                for trial_id in selected:
                    trial = by_id[trial_id]
                    evaluations.append(self.evaluation(trial, "solver", (trial.variables["x"] - 0.25) ** 2))
                if reason:
                    break
            else:
                self.fail("Search did not finish within its candidate budget")
            return trace

        trace = run(False)
        self.assertEqual(run(True), trace)
        self.assertEqual([[item["variables"]["x"] for item in generated]
                          for _, generated, _, _ in trace if generated],
                         [[0.5], [0.75, 0.25], [0], [0.375, 0.125], [0.3125, 0.1875]])
        self.assertEqual([selected for _, _, selected, _ in trace if selected],
                         [["1"], ["2", "3"], ["4"], ["5", "6"], ["7", "8"]])
        self.assertEqual((trace[-1][0]["incumbent_ordinal"], trace[-1][3]), (3, "candidate_limit"))

    def test_prediction_winner_and_failed_solver_cannot_move_center(self):
        trials = [self.trial(1, 0.5), self.trial(2, 0.75), self.trial(3, 0.25)]
        evaluations = [self.evaluation(trial, "prediction", -trial.ordinal) for trial in trials]
        evaluations.extend([self.evaluation(trials[0], "solver", 10),
                            self.evaluation(trials[1], "solver", -100, state="failed")])
        state, generated, selected, reason = advance_search(trials, evaluations, self.settings,
            {"round_ordinals": [1, 2, 3], "selection": ["1", "2"]}, {"remaining": 3})
        self.assertEqual(state["incumbent_ordinal"], 1)
        self.assertEqual([item["variables"]["x"] for item in generated], [0.625, 0.375])
        self.assertEqual((selected, reason), ([], None))

    def test_budget_reservations_wait_and_consumed_budget_terminates(self):
        trial = self.trial(1, 0.5)
        evaluations = [self.evaluation(trial, "prediction", 1)]
        for used, reserved, reason in ((1, 1, None), (2, 0, "solver_budget_exhausted")):
            with self.subTest(used=used, reserved=reserved):
                result = advance_search([trial], evaluations, self.settings, {},
                    {"limit": 2, "used": used, "reserved": reserved, "remaining": 0})
                self.assertEqual(result[1:], ([], [], reason))

    def test_incomplete_predictions_and_unfinished_solver_wait(self):
        trial = self.trial(1, 0.5)
        for kind, states in (("prediction", ("pending", "running", "failed", "cancelled")),
                             ("solver", ("pending", "running", "cancelled"))):
            for status in states:
                with self.subTest(kind=kind, state=status):
                    evaluations = [self.evaluation(trial, "prediction", 1)] if kind == "solver" else []
                    evaluations.append(self.evaluation(trial, kind, 1, state=status))
                    result = advance_search([trial], evaluations, self.settings, {}, {"remaining": 1})
                    self.assertEqual(result[1:], ([], [], None))

    def test_candidate_generation_skips_known_vars_and_preserves_input_state(self):
        trials = [self.trial(1, 0.5), self.trial(2, 0.75), self.trial(3, 0.25)]
        state = {"step": 0.25, "round_index": 1, "runtime_id": "runtime", "extra": {"values": [1]}}
        original = deepcopy((trials, self.settings, state))
        result, candidates = generate_coordinate_round(trials, trials[0], self.settings, state)
        self.assertEqual((trials, self.settings, state), original)
        self.assertEqual((result["step"], result["round_index"], result["round_ordinals"]), (0.125, 2, [4, 5]))
        self.assertEqual([candidate["variables"]["x"] for candidate in candidates], [0.625, 0.375])
        result["extra"]["values"].append(2)
        self.assertEqual(state["extra"], {"values": [1]})
        self.assertEqual(result["runtime_id"], "runtime")

    def test_fixed_axes_converge_after_initial_verification(self):
        self.settings["axes"][0]["fixed"] = True
        trial = self.trial(1, 0.5)
        evaluations = [self.evaluation(trial, kind, 1) for kind in ("prediction", "solver")]
        state, candidates, selected, reason = advance_search([trial], evaluations, self.settings,
            {"selection": [trial.id]}, {"remaining": 2})
        self.assertEqual((candidates, selected, reason), ([], [], "search_converged"))
        self.assertTrue(state["generation_complete"])
        self.assertLess(state["step"], self.settings["min_step"])

    def test_selection_ordinal_ties_ignore_input_order_and_fixed_axes(self):
        trials = [self.trial(1, 0.5), self.trial(2, 0.25), self.trial(3, 0.75)]
        predictions = {trial.id: self.evaluation(trial, "prediction", 1) for trial in trials}
        for direction in ("minimize", "maximize"):
            with self.subTest(direction=direction):
                self.assertEqual(select_verifications(list(reversed(trials)), predictions, [],
                    self.settings["axes"], direction, 3), ["1", "2"])
        self.settings["axes"][0]["fixed"] = True
        self.assertEqual(select_verifications(list(reversed(trials)), predictions, [],
            self.settings["axes"], "minimize", 3), ["1", "2"])
        self.assertEqual(select_verifications([], {}, [], self.settings["axes"], "minimize", 3), [])


if __name__ == "__main__":
    unittest.main()
