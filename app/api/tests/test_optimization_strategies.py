"""Deterministic strategy/verification contracts without Solver or database work."""
from copy import deepcopy
import json
import math
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from pydantic import ValidationError

from optimization.algorithm import prepare_axes, variables_fingerprint
from optimization.configuration import ALGORITHM_CONFIG, VerificationPolicy
from optimization.search import advance_search, advance_solver_search, initialize_search, continuation_assessment, observation_snapshots
from optimization.strategies import SEARCH_STRATEGIES, Candidate, Observation, Proposal, SearchProblem, SearchStrategy
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
        state = {**initialize_search(settings), "runtime_id": "preserve", "model_update": {"waiting": False}}
        trials, evaluations, trace = [], [], []
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

    def test_all_strategies_and_modes_resume_identically_from_json(self):
        for algorithm in ("coordinate", "random", "de"):
            for hybrid in (False, True):
                with self.subTest(algorithm=algorithm, hybrid=hybrid):
                    config = {"coordinate": {}, "random": {"seed": 14, "candidates_per_round": 2},
                              "de": {"seed": 14, "population_size": 4}}[algorithm]
                    settings = self.settings(algorithm, **config)
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
            state, candidates, _, _ = advance_solver_search([], settings, initialize_search(settings))
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
        state = initialize_search(settings)
        for broken in ({}, {**state, "search_version": 1}, {**state, "search_version": 3},
                       {**state, "search_version": True}, {**state, "completed_round_index": 2},
                       {**state, "round_ordinals": [1, 1]},
                       {**state, "algorithm_state": {**state["algorithm_state"], "state_version": 1}},
                       {**state, "algorithm_state": {**state["algorithm_state"], "data": {"rng_state": None}}}):
            original = deepcopy(broken)
            with self.assertRaisesRegex(ValueError, "state"):
                advance_solver_search([], settings, broken)
            self.assertEqual(broken, original)
            self.assertFalse(continuation_assessment(settings, broken)["supported"])
        self.assertTrue(continuation_assessment(settings, state)["supported"])
        with self.assertRaisesRegex(ValueError, "state"):
            advance_solver_search([SimpleNamespace()], settings, {})

    def test_strategy_and_verification_are_independently_dispatched(self):
        strategy = SEARCH_STRATEGIES[("random", 1)]
        generate = unittest.mock.Mock(wraps=strategy.propose)
        with patch.dict(SEARCH_STRATEGIES, {("random", 1): SearchStrategy(strategy.initialize, strategy.validate, generate, strategy.observe)}), \
             patch.dict(VERIFICATION_POLICIES, {("best_predicted_maximin", 1): unittest.mock.Mock(wraps=VERIFICATION_POLICIES[("best_predicted_maximin", 1)])}):
            self.run_search(self.settings(), hybrid=True)
            self.assertTrue(generate.called)
            self.assertTrue(VERIFICATION_POLICIES[("best_predicted_maximin", 1)].called)

    def test_population_strategy_owns_feedback_without_coordinator_changes(self):
        def initialize(problem):
            return {"population": [], "generations": 0}

        def validate(state):
            self.assertEqual(set(state), {"population", "generations"})
            self.assertIsInstance(state["population"], list)
            self.assertIsInstance(state["generations"], int)

        def observe(problem, state, observations, members):
            self.assertIsInstance(problem, SearchProblem)
            self.assertNotIn("model_update", vars(problem))
            self.assertTrue(all(isinstance(item, Observation) for item in observations))
            population = sorted((item for item in observations if item.kind == "solver" and item.ordinal in members),
                                key=lambda item: item.result["objective"])
            return {"population": [item.ordinal for item in population], "generations": state["generations"] + 1}

        def propose(problem, state, candidates, observations, remaining):
            self.assertTrue(all(type(item) is Candidate for item in candidates))
            if state["generations"] == 2:
                return Proposal(deepcopy(state), complete=True)
            values = (0.25, 0.75) if not candidates else (0.125, 0.875)
            generated = []
            for value in values[:remaining]:
                variables = deepcopy(problem.initial_vars)
                variables["x"] = value
                generated.append(Candidate(len(candidates) + len(generated) + 1, variables, variables_fingerprint(variables)))
            return Proposal(deepcopy(state), tuple(generated), tuple(item.ordinal for item in generated))

        strategy = SearchStrategy(initialize, validate, propose, observe)
        with patch.dict(SEARCH_STRATEGIES, {("coordinate", 1): strategy}):
            for hybrid in (False, True):
                with self.subTest(hybrid=hybrid):
                    trace = self.run_search(self.settings("coordinate"), hybrid=hybrid)
                    self.assertEqual(trace, self.run_search(self.settings("coordinate"), hybrid=hybrid, restore=True))
                    self.assertEqual(trace[-1][0]["algorithm_state"]["data"], {"population": [3, 4], "generations": 2})
                    self.assertEqual(trace[-1][3], "search_converged")

    def test_completed_round_is_observed_once_while_saved_candidates_are_verified(self):
        settings = self.settings("coordinate")
        settings["max_trials"] = 3
        state, definitions, _, _ = advance_solver_search([], settings, initialize_search(settings))
        trials = [SimpleNamespace(**definitions[0], id="1", state="succeeded",
                                  result={"objective": 1, "feasible": True, "violation": 0})]
        for ordinal, value in ((2, 0.25), (3, 0.75)):
            variables = {**settings["initial_vars"], "x": value}
            trials.append(SimpleNamespace(id=str(ordinal), ordinal=ordinal, variables=variables,
                                          fingerprint=variables_fingerprint(variables)))
        evaluations = [SimpleNamespace(id=f"p{item.id}", trial_id=item.id, kind="prediction", state="succeeded",
                                       result={"objective": item.ordinal, "feasible": True, "violation": 0}) for item in trials]
        evaluations.append(SimpleNamespace(id="s1", trial_id="1", kind="solver", state="succeeded", result=trials[0].result))
        state["selection"] = ["1"]
        strategy = SEARCH_STRATEGIES[("coordinate", 1)]
        observed = unittest.mock.Mock(wraps=strategy.observe)
        with patch.dict(SEARCH_STRATEGIES, {("coordinate", 1): SearchStrategy(strategy.initialize, strategy.validate, strategy.propose, observed)}):
            state, _, selected, _ = advance_search(trials, evaluations, settings, state, {"remaining": 2})
            self.assertEqual(selected, ["2", "3"])
            self.assertEqual(observed.call_count, 1)
            # The persisted selection is not complete until both Evaluations exist.
            repeated = advance_search(trials, evaluations, settings, state, {"remaining": 2})
            self.assertEqual(repeated, (state, [], [], None))
            for identity in selected:
                evaluations.append(SimpleNamespace(id=f"s{identity}", trial_id=identity, kind="solver", state="succeeded",
                    result={"objective": int(identity), "feasible": True, "violation": 0}))
            state, _, _, reason = advance_search(trials, evaluations, settings, state, {"remaining": 2})
            self.assertEqual(reason, "candidate_limit")
            self.assertEqual(observed.call_count, 1)
            self.assertEqual(state["completed_round_index"], 0)

    def test_observations_keep_provenance_and_never_turn_errors_into_scores(self):
        candidate = Candidate(1, {"x": 0.5}, "fingerprint", "candidate")
        common = {"trial_id": candidate.id, "definition_hash": "definition", "source_hash": "source",
                  "source": {"model_revision": 7}, "result": {"objective": -100, "feasible": True, "violation": 0}}
        evaluations = [SimpleNamespace(**common, id="predicted", kind="prediction", state="succeeded", error=None),
                       SimpleNamespace(**common, id="failed", kind="solver", state="failed", error={"message": "transport"})]
        observations = observation_snapshots((candidate,), evaluations)
        self.assertEqual([(item.kind, item.evaluation_id) for item in observations], [("prediction", "predicted"), ("solver", "failed")])
        self.assertEqual(observations[0].source, {"model_revision": 7})
        self.assertEqual(observations[0].definition_hash, "definition")
        self.assertIsNone(observations[1].result)
        self.assertEqual(observations[1].error, {"message": "transport"})
        observations[0].source["model_revision"] = 99
        self.assertEqual(evaluations[0].source, {"model_revision": 7})

    def test_coordinate_strategy_data_rejects_missing_nonfinite_or_invalid_incumbent(self):
        settings = self.settings("coordinate")
        original = initialize_search(settings)
        for key, value in (("step", float("nan")), ("step", -1), ("incumbent_ordinal", True), ("center_unchanged", None)):
            state = deepcopy(original)
            state["algorithm_state"]["data"][key] = value
            self.assertFalse(continuation_assessment(settings, state)["supported"])
        state = deepcopy(original)
        del state["algorithm_state"]["data"]["step"]
        self.assertFalse(continuation_assessment(settings, state)["supported"])

    def test_solver_observations_use_persisted_evaluation_identity_and_authoritative_result(self):
        settings = self.settings("coordinate")
        state, definitions, _, _ = advance_solver_search([], settings, initialize_search(settings))
        trial = SimpleNamespace(**definitions[0], id="trial", state="succeeded",
                                result={"objective": -999, "feasible": True, "violation": 0})
        evaluation = SimpleNamespace(id="evaluation", trial_id=trial.id, kind="solver", state="succeeded",
            definition_hash="definition", source_hash="source", source={"catalog_revision": "catalog"},
            result={"objective": 4, "feasible": False, "violation": 2}, error=None)
        strategy = SEARCH_STRATEGIES[("coordinate", 1)]
        observed = unittest.mock.Mock(wraps=strategy.observe)
        with patch.dict(SEARCH_STRATEGIES, {("coordinate", 1): SearchStrategy(strategy.initialize, strategy.validate, strategy.propose, observed)}):
            # A Trial projection alone cannot stand in for a missing durable result.
            self.assertEqual(advance_solver_search([trial], settings, state, evaluations=[]), (state, [], [], None))
            advance_solver_search([trial], settings, state, evaluations=[evaluation])
        snapshot = observed.call_args.args[2][0]
        self.assertEqual((snapshot.evaluation_id, snapshot.definition_hash, snapshot.source_hash), ("evaluation", "definition", "source"))
        self.assertEqual(snapshot.result, evaluation.result)
        self.assertNotEqual(snapshot.result, trial.result)

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
