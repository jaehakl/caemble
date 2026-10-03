"""DE numerical and partial-verification contracts without Solver jobs or a database."""
from copy import deepcopy
from itertools import permutations
import json
import math
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from optimization.algorithm import prepare_axes, variables_fingerprint
from optimization.configuration import ALGORITHM_CONFIG, saved_algorithm
from optimization.search import advance_search, advance_solver_search, initialize_search, search_problem
from optimization.strategies import Candidate, Observation, SEARCH_STRATEGIES


class DifferentialEvolutionTests(unittest.TestCase):
    def setUp(self):
        self.strategy = SEARCH_STRATEGIES[("de", 1)]
        variables = {"x": 0.4, "tensor": [[0.3, 0.7]]}
        schema = {"x": {"shape": [], "min": 0, "max": 1},
                  "tensor": {"shape": [1, 2], "min": 0, "max": 1}}
        self.settings = {"initial_vars": variables, "axes": prepare_axes(schema, variables,
                            [{"name": "tensor", "indices": [0, 1], "fixed": True}]),
                         "objective": {"direction": "minimize"}, "max_trials": 20,
                         "algorithm": {"id": "de", "config": {"population_size": 4, "seed": 42}}}

    def problem(self, **config):
        settings = deepcopy(self.settings)
        settings["algorithm"]["config"].update(config)
        return search_problem(settings, saved_algorithm(settings))

    def observation(self, ordinal, objective, *, kind="solver", state="succeeded", feasible=True, violation=0):
        variables = {"x": ordinal / 10}
        return Observation(Candidate(ordinal, variables, variables_fingerprint(variables)), str(ordinal), kind, state,
                           {"objective": objective, "feasible": feasible, "violation": violation}
                           if state == "succeeded" else None)

    def generation_state(self, problem):
        state = self.strategy.initialize(problem)
        state.update(population=[1, 2, 3, 4], generation=1, pending=[
            {"slot": slot, "target_ordinal": slot + 1, "child_ordinal": slot + 5} for slot in range(4)])
        return state

    def test_configuration_defaults_limits_and_strict_types(self):
        self.assertEqual(ALGORITHM_CONFIG.validate_python({"id": "de"}).model_dump(), {
            "id": "de", "version": 1, "config": {"population_size": 8, "mutation_factor": 0.8,
                                                  "crossover_rate": 0.9, "seed": 0}})
        for key, value in (("population_size", 3), ("population_size", 33), ("population_size", True),
                           ("population_size", 4.5), ("mutation_factor", 0), ("mutation_factor", 2),
                           ("mutation_factor", float("nan")), ("mutation_factor", float("inf")),
                           ("crossover_rate", -0.1), ("crossover_rate", 1.1), ("crossover_rate", True),
                           ("seed", -1), ("seed", 2**32), ("seed", 0.5), ("unknown", 1)):
            with self.subTest(key=key, value=value), self.assertRaises(ValidationError):
                ALGORITHM_CONFIG.validate_python({"id": "de", "config": {key: value}})
        for version in (0, 2, True):
            with self.subTest(version=version), self.assertRaises(ValidationError):
                ALGORITHM_CONFIG.validate_python({"id": "de", "version": version})
        for rate in (0, 1):
            self.assertEqual(ALGORITHM_CONFIG.validate_python({"id": "de", "config": {"crossover_rate": rate}}).config.crossover_rate, rate)

    def test_initial_population_partial_budget_fixed_axes_and_seed(self):
        problem = self.problem(population_size=8)
        initial = self.strategy.initialize(problem)
        for budget in (1, 3, 4, 7, 8):
            with self.subTest(budget=budget):
                proposal = self.strategy.propose(problem, initial, (), (), budget)
                self.assertEqual(len(proposal.candidates), budget)
                self.assertEqual(proposal.candidates[0].variables, problem.initial_vars)
                self.assertTrue(proposal.complete)
                self.assertEqual(proposal.state["population"], list(range(1, budget + 1)))
        first = self.strategy.propose(problem, initial, (), (), 20)
        other = self.problem(population_size=8, seed=43)
        second = self.strategy.propose(other, self.strategy.initialize(other), (), (), 20)
        self.assertNotEqual(first.candidates[1:], second.candidates[1:])
        self.assertEqual(initial, self.strategy.initialize(problem))
        for axis in self.settings["axes"]:
            axis["fixed"] = True
        fixed = self.problem()
        proposal = self.strategy.propose(fixed, self.strategy.initialize(fixed), (), (), 20)
        self.assertEqual(len(proposal.candidates), 1)
        self.assertTrue(proposal.complete)

    def test_rand_one_mutation_excludes_target_and_uses_same_donors_across_axes(self):
        problem = self.problem(mutation_factor=0.5, crossover_rate=1)
        initial = self.strategy.propose(problem, self.strategy.initialize(problem), (), (), 20)
        proposal = self.strategy.propose(problem, initial.state, initial.candidates, (), 16)
        self.assertEqual(len(proposal.candidates), 4)
        self.assertEqual(proposal.state["generation"], 1)
        for challenge, child in zip(proposal.state["pending"], proposal.candidates):
            slot = challenge["slot"]
            donors = [candidate for index, candidate in enumerate(initial.candidates) if index != slot]
            allowed = []
            for a, b, c in permutations(donors):
                values = []
                for key in ("x", "tensor"):
                    get = (lambda item: item.variables["x"]) if key == "x" else (lambda item: item.variables["tensor"][0][0])
                    values.append(min(1, max(0, get(a) + 0.5 * (get(b) - get(c)))))
                allowed.append(values)
            actual = [child.variables["x"], child.variables["tensor"][0][0]]
            self.assertIn(actual, allowed)
            self.assertEqual(child.variables["tensor"][0][1], 0.7)

    def test_zero_crossover_still_changes_one_element_and_preserves_other_values_exactly(self):
        problem = self.problem(crossover_rate=0)
        initial = self.strategy.propose(problem, self.strategy.initialize(problem), (), (), 20)
        proposal = self.strategy.propose(problem, initial.state, initial.candidates, (), 16)
        self.assertEqual(len(proposal.candidates), 4)
        for challenge, child in zip(proposal.state["pending"], proposal.candidates):
            target = initial.candidates[challenge["slot"]].variables
            changed = sum((child.variables["x"] != target["x"],
                           child.variables["tensor"][0][0] != target["tensor"][0][0]))
            self.assertEqual(changed, 1)
            self.assertEqual(child.variables["tensor"][0][1], target["tensor"][0][1])

    def test_hybrid_requires_actual_child_and_later_verification_cannot_replay_challenges(self):
        self.settings["hybrid"] = {"verification_policy": {"id": "best_predicted_maximin"}}
        problem = self.problem()
        state = self.generation_state(problem)
        snapshot = deepcopy(state)
        observations = (self.observation(1, 10), self.observation(2, 1), self.observation(4, 10),
                        self.observation(5, -999, kind="prediction"), self.observation(6, 5),
                        self.observation(7, 100), self.observation(8, 9))
        observed = self.strategy.observe(problem, state, observations, (5, 6, 7, 8))
        self.assertEqual(observed["population"], [1, 2, 7, 8])
        self.assertEqual(observed["pending"], [])
        self.assertEqual(state, snapshot)
        late = self.strategy.observe(problem, observed, (*observations, self.observation(5, -1000)), (1, 3, 5, 6))
        self.assertEqual(late, observed)
        self.assertIsNot(late, observed)
        self.assertEqual(late["generation"], 1)

    def test_actual_replacement_obeys_direction_feasibility_violation_and_ties(self):
        for direction, parent, child, replaces in (
                ("minimize", (2, True, 0), (1, True, 0), True),
                ("maximize", (2, True, 0), (1, True, 0), False),
                ("maximize", (2, True, 0), (3, True, 0), True),
                ("minimize", (2, True, 0), (2, True, 0), False),
                ("minimize", (2, True, 0), (-99, False, 0.1), False),
                ("minimize", (-99, False, 0.1), (99, True, 0), True),
                ("minimize", (2, False, 0.5), (99, False, 0.2), True)):
            with self.subTest(direction=direction, parent=parent, child=child):
                self.settings["objective"]["direction"] = direction
                problem = self.problem()
                state = self.generation_state(problem)
                state["pending"] = state["pending"][:1]
                observations = (self.observation(1, parent[0], feasible=parent[1], violation=parent[2]),
                                self.observation(5, child[0], feasible=child[1], violation=child[2]))
                observed = self.strategy.observe(problem, state, observations, (5,))
                self.assertEqual(observed["population"][0], 5 if replaces else 1)

    def test_saved_state_rejects_invalid_population_generation_rng_and_challenges(self):
        original = self.generation_state(self.problem())
        self.strategy.validate(json.loads(json.dumps(original)))
        for key, value in (("population", [1, 1, 2, 3]), ("population", [True, 2, 3, 4]),
                           ("population", []), ("population", [1, 2, 3]),
                           ("generation", -1), ("generation", True), ("rng_state", None),
                           ("pending", [{"slot": 0, "target_ordinal": 2, "child_ordinal": 5}]),
                           ("pending", [{"slot": 0, "target_ordinal": 1, "child_ordinal": 2}]),
                           ("pending", [original["pending"][0], original["pending"][0]])):
            with self.subTest(key=key, value=value), self.assertRaisesRegex(ValueError, "state"):
                self.strategy.validate({**original, key: value})
        broken = deepcopy(original)
        del broken["population"]
        with self.assertRaisesRegex(ValueError, "state"):
            self.strategy.validate(broken)
        with self.assertRaisesRegex(ValueError, "pending"):
            self.strategy.propose(self.problem(), original, (), (), 10)
        with self.assertRaisesRegex(ValueError, "completed generation"):
            self.strategy.observe(self.problem(), original, (), (1, 2, 3, 4))
        with self.assertRaisesRegex(ValueError, "Solver observations"):
            self.strategy.observe(self.problem(), original, (self.observation(5, -99, state="failed"),), (5, 6, 7, 8))
        with self.assertRaisesRegex(ValueError, "Solver observations for its parents"):
            self.strategy.observe(self.problem(), original, (self.observation(5, -99),), (5, 6, 7, 8))
        problem = self.problem()
        empty = self.strategy.initialize(problem)
        initial = self.strategy.propose(problem, empty, (), (), 20)
        with self.assertRaisesRegex(ValueError, "history"):
            self.strategy.propose(problem, empty, initial.candidates, (), 10)
        with self.assertRaisesRegex(ValueError, "history"):
            self.strategy.propose(problem, initial.state, (), (), 10)
        with self.assertRaisesRegex(ValueError, "completed round"):
            self.strategy.observe(problem, empty, (), (1, 2, 3, 4))
        oversized = self.problem(population_size=8)
        population = self.strategy.propose(oversized, self.strategy.initialize(oversized), (), (), 20)
        with self.assertRaisesRegex(ValueError, "configured size"):
            self.strategy.propose(problem, population.state, population.candidates, (), 10)
        with self.assertRaisesRegex(ValueError, "configured size"):
            self.strategy.observe(problem, population.state, (), tuple(range(1, 9)))

    def test_extreme_ranges_duplicates_and_partial_last_generation(self):
        for lower, upper, initial in ((1., math.nextafter(1., 2.), 1.),
                                      (-1.7e308, 1.7e308, 0.), (-5e-324, 5e-324, 0.)):
            with self.subTest(lower=lower, upper=upper):
                self.settings.update(initial_vars={"x": initial}, axes=[
                    {"name": "x", "indices": [], "min": lower, "max": upper, "fixed": False}])
                state, trials, fingerprints = initialize_search(self.settings), [], set()
                for _ in range(15):
                    state, generated, _, reason = advance_solver_search(trials, self.settings, state)
                    for candidate in generated:
                        value = candidate["variables"]["x"]
                        self.assertTrue(math.isfinite(value) and lower <= value <= upper)
                        self.assertNotIn(candidate["fingerprint"], fingerprints)
                        fingerprints.add(candidate["fingerprint"])
                        trials.append(SimpleNamespace(**candidate, id=str(candidate["ordinal"]), state="succeeded",
                            result={"objective": abs(value) / max(1, abs(upper)), "feasible": True, "violation": 0}))
                    if reason:
                        break
                else:
                    self.fail("DE did not terminate")
                if lower == 1.:
                    self.assertEqual(len(trials), 2)
                if lower == -5e-324:
                    self.assertEqual(len(trials), 3)
        self.setUp()
        problem = self.problem(population_size=8)
        initial = self.strategy.propose(problem, self.strategy.initialize(problem), (), (), 10)
        final = self.strategy.propose(problem, initial.state, initial.candidates, (), 2)
        self.assertEqual(len(final.candidates), 2)
        self.assertTrue(final.complete)

    def test_hybrid_coordinator_consumes_generation_before_tail_validation(self):
        self.settings["max_trials"] = 8
        self.settings["hybrid"] = {"verification_policy": {"id": "best_predicted_maximin"}}
        state = {**initialize_search(self.settings), "round_source_hash": "model"}
        trials, evaluations = [], []
        population_at_tail = None
        for _ in range(30):
            state, generated, selected, reason = advance_search(trials, evaluations, self.settings, state,
                                                               {"remaining": 20, "used": 0, "limit": 20})
            for candidate in generated:
                trial = SimpleNamespace(**candidate, id=str(candidate["ordinal"]))
                trials.append(trial)
                evaluations.append(SimpleNamespace(trial_id=trial.id, kind="prediction", state="succeeded",
                    source_hash="model", result={"objective": -trial.ordinal, "feasible": True, "violation": 0}))
            for identity in selected:
                evaluations.append(SimpleNamespace(trial_id=identity, kind="solver", state="succeeded",
                    source_hash="solver", result={"objective": -int(identity), "feasible": True, "violation": 0}))
            data = state["algorithm_state"]["data"]
            if state["round_index"] >= 2:
                self.assertEqual(data["pending"], [])
                self.assertEqual(data["generation"], 1)
                if population_at_tail is None:
                    population_at_tail = deepcopy(data)
                self.assertEqual(data, population_at_tail)
            if reason:
                break
        else:
            self.fail("Hybrid DE did not terminate")
        self.assertIsNotNone(population_at_tail)
        self.assertEqual(len([item for item in evaluations if item.kind == "solver"]), 8)
        self.assertEqual(reason, "candidate_limit")


if __name__ == "__main__":
    unittest.main()
