"""Deterministic strategy/verification contracts without Solver or database work."""
from copy import deepcopy
import json
import math
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from pydantic import ValidationError

from optimization.algorithm import prepare_axes
from optimization.configuration import ALGORITHM_CONFIG, VerificationPolicy
from optimization.search import advance_search, advance_solver_search
from optimization.strategies import SEARCH_STRATEGIES, SearchStrategy
from optimization.verification import VERIFICATION_POLICIES


class StrategyTests(unittest.TestCase):
    def settings(self, algorithm="random", **config):
        variables = {"x": 0.5, "tensor": [[0.5, 0.5]]}
        schema = {"x": {"shape": [], "min": 0, "max": 1}, "tensor": {"shape": [1, 2], "min": 0, "max": 1}}
        return {"initial_vars": variables, "axes": prepare_axes(schema, variables,
                    [{"name": "tensor", "indices": [0, 1], "fixed": True}]),
                "objective": {"direction": "minimize"}, "max_trials": 9,
                "algorithm": {"id": algorithm, "config": config}}

    def run_search(self, settings, *, hybrid, restore=False):
        state, trials, evaluations, trace = {"runtime_id": "preserve", "model_update": {"waiting": False}}, [], [], []
        for _ in range(50):
            if restore:
                state = json.loads(json.dumps(state))
                trials = [SimpleNamespace(**json.loads(json.dumps(vars(item)))) for item in reversed(trials)]
                evaluations = [SimpleNamespace(**json.loads(json.dumps(vars(item)))) for item in reversed(evaluations)]
            inputs = deepcopy((settings, state, trials, evaluations))
            used = sum(item.kind == "solver" for item in evaluations)
            budget = {"limit": 7, "used": used, "remaining": 7 - used}
            result = (advance_search(trials, evaluations, settings, state, budget) if hybrid
                      else advance_solver_search(trials, settings, state))
            self.assertEqual((settings, state, trials, evaluations), inputs)
            # Reconciliation before commit/after rollback produces the same decision.
            repeated = (advance_search(trials, evaluations, settings, state, budget) if hybrid
                        else advance_solver_search(trials, settings, state))
            self.assertEqual(result, repeated)
            state, generated, selected, reason = result
            trace.append(deepcopy(result))
            for candidate in generated:
                score = {"objective": (candidate["variables"]["x"] - 0.2) ** 2, "feasible": True, "violation": 0}
                trial = SimpleNamespace(**candidate, id=str(candidate["ordinal"]), state="succeeded", result=score)
                trials.append(trial)
                evaluations.append(SimpleNamespace(trial_id=trial.id, kind="prediction", state="succeeded", result=score))
            for identity in selected:
                trial = next(item for item in trials if item.id == identity)
                evaluations.append(SimpleNamespace(trial_id=identity, kind="solver", state="succeeded", result=trial.result))
            if reason:
                break
        else:
            self.fail("Search did not terminate")
        self.assertEqual(len({trial.fingerprint for trial in trials}), len(trials))
        self.assertEqual(state["runtime_id"], "preserve")
        self.assertEqual(state["model_update"], {"waiting": False})
        self.assertTrue(all(trial.variables["tensor"][0][1] == 0.5 for trial in trials))
        return trace

    def test_both_strategies_and_modes_resume_identically_from_json(self):
        for algorithm in ("coordinate", "random"):
            for hybrid in (False, True):
                with self.subTest(algorithm=algorithm, hybrid=hybrid):
                    settings = self.settings(algorithm, **({"seed": 14, "candidates_per_round": 2} if algorithm == "random" else {}))
                    self.assertEqual(self.run_search(settings, hybrid=hybrid),
                                     self.run_search(settings, hybrid=hybrid, restore=True))

    def test_seed_changes_candidates_and_all_samples_stay_inside_tensor_bounds(self):
        first = self.run_search(self.settings(seed=0), hybrid=False)
        second = self.run_search(self.settings(seed=1), hybrid=False)
        self.assertNotEqual(first[1][1], second[1][1])
        for _, candidates, _, _ in first:
            for item in candidates:
                self.assertTrue(0 <= item["variables"]["x"] <= 1)
                self.assertTrue(all(0 <= value <= 1 for value in item["variables"]["tensor"][0]))

    def test_bounded_duplicate_sampling_and_extreme_finite_ranges(self):
        for lower, upper, initial in ((1., math.nextafter(1., 2.), 1.), (-1.7e308, 1.7e308, 0.)):
            settings = self.settings()
            settings.update(initial_vars={"x": initial}, axes=[{"name": "x", "indices": [], "fixed": False,
                                                              "min": lower, "max": upper}])
            state, candidates, _, _ = advance_solver_search([], settings, {})
            trial = SimpleNamespace(**candidates[0], id="1", state="succeeded",
                                    result={"objective": 0, "feasible": True, "violation": 0})
            state, candidates, _, _ = advance_solver_search([trial], settings, state)
            self.assertTrue(all(math.isfinite(item["variables"]["x"]) and lower <= item["variables"]["x"] <= upper for item in candidates))
            self.assertEqual(len({item["fingerprint"] for item in candidates}), len(candidates))
            if lower == 1.:
                self.assertEqual(len(candidates), 1)
                self.assertTrue(state["generation_complete"])

    def test_fixed_axes_evaluate_only_initial_candidate_in_both_modes(self):
        settings = self.settings()
        for axis in settings["axes"]:
            axis["fixed"] = True
        for hybrid in (False, True):
            trace = self.run_search(settings, hybrid=hybrid)
            self.assertEqual(sum(len(item[1]) for item in trace), 1)

    def test_unsupported_or_missing_state_fails_without_reset(self):
        settings = self.settings()
        state, _, _, _ = advance_solver_search([], settings, {})
        for broken in ({**state, "search_version": 2},
                       {**state, "algorithm_state": {**state["algorithm_state"], "state_version": 2}},
                       {**state, "algorithm_state": {**state["algorithm_state"], "rng_state": None}}):
            original = deepcopy(broken)
            with self.assertRaisesRegex(ValueError, "state"):
                advance_solver_search([], settings, broken)
            self.assertEqual(broken, original)
        with self.assertRaisesRegex(ValueError, "missing"):
            advance_solver_search([SimpleNamespace()], settings, {})

    def test_strategy_and_verification_are_independently_dispatched(self):
        strategy = SEARCH_STRATEGIES[("random", 1)]
        generate = unittest.mock.Mock(wraps=strategy.generate_round)
        with patch.dict(SEARCH_STRATEGIES, {("random", 1): SearchStrategy(strategy.prepare_state, generate)}), \
             patch.dict(VERIFICATION_POLICIES, {("best_predicted_maximin", 1): unittest.mock.Mock(wraps=VERIFICATION_POLICIES[("best_predicted_maximin", 1)])}):
            self.run_search(self.settings(), hybrid=True)
            self.assertTrue(generate.called)
            self.assertTrue(VERIFICATION_POLICIES[("best_predicted_maximin", 1)].called)

    def test_configuration_defaults_and_invalid_versions(self):
        self.assertEqual(ALGORITHM_CONFIG.validate_python({"id": "random"}).config.seed, 0)
        for value in ({"id": "missing"}, {"id": "random", "version": True}, {"id": "random", "version": 2},
                      {"id": "random", "config": {"seed": -1}}, {"id": "random", "config": {"seed": 2**32}},
                      {"id": "random", "config": {"seed": 1.5}}, {"id": "random", "config": {"candidates_per_round": 33}},
                      {"id": "coordinate", "config": {"initial_step": 0}},
                      {"id": "coordinate", "config": {"initial_step": 0.1, "min_step": 0.2}},
                      {"id": "coordinate", "config": {"initial_step": float("inf")}}):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                ALGORITHM_CONFIG.validate_python(value)
        with self.assertRaises(ValidationError):
            VerificationPolicy.model_validate({"id": "best_predicted_maximin", "config": {"count": 3}})
