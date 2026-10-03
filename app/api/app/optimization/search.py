"""Pure round coordination; callers atomically persist decisions and candidates."""
from copy import deepcopy
from dataclasses import replace

from optimization.configuration import saved_algorithm, VerificationPolicy
from optimization.strategies import Candidate, Observation, SearchProblem, SEARCH_STRATEGIES
from optimization.verification import VERIFICATION_POLICIES, select_verifications

SEARCH_VERSION = 2
CONTINUATION_REASON = "This Optimization uses an unsupported execution version. Create a new Optimization to continue."


def search_problem(settings, algorithm):
    return SearchProblem(deepcopy(settings["initial_vars"]), tuple(deepcopy(settings["axes"])),
        settings["objective"]["direction"], tuple(deepcopy(settings.get("constraints", []))),
        deepcopy(algorithm["config"]), "hybrid" if settings.get("hybrid") else "solver")


def initialize_search(settings):
    """Create a complete state only when a new Optimization is admitted."""
    algorithm = saved_algorithm(settings)
    strategy = SEARCH_STRATEGIES[(algorithm["id"], algorithm["version"])]
    problem = search_problem(settings, algorithm)
    data = strategy.initialize(problem)
    strategy.validate(data)
    return {"search_version": SEARCH_VERSION, "algorithm_state": {
        "id": algorithm["id"], "version": algorithm["version"], "state_version": strategy.state_version, "data": data},
        "round_index": 0, "completed_round_index": -1, "round_ordinals": [1], "selection": [],
        "generation_complete": False}


def prepare_search(settings, state, has_trials):
    """Validate saved state without upgrading it or restarting a random stream."""
    state = deepcopy(state)
    if not isinstance(state, dict) or type(state.get("search_version")) is not int or state["search_version"] != SEARCH_VERSION:
        raise ValueError("Unsupported Optimization search state version. " + CONTINUATION_REASON)
    algorithm = saved_algorithm(settings)
    strategy = SEARCH_STRATEGIES[(algorithm["id"], algorithm["version"])]
    identity = {"id": algorithm["id"], "version": algorithm["version"], "state_version": strategy.state_version}
    saved = state.get("algorithm_state")
    if (not isinstance(saved, dict) or set(saved) != {*identity, "data"}
            or any(type(saved.get(key)) is not type(value) or saved.get(key) != value for key, value in identity.items())):
        raise ValueError("Unsupported Optimization algorithm state or implementation version. " + CONTINUATION_REASON)
    strategy.validate(saved["data"])
    index, completed, ordinals = state.get("round_index"), state.get("completed_round_index"), state.get("round_ordinals")
    if (type(index) is not int or index < 0 or type(completed) is not int or not -1 <= completed <= index
            or not isinstance(ordinals, list) or any(type(item) is not int or item < 1 for item in ordinals)
            or len(set(ordinals)) != len(ordinals) or (has_trials and not ordinals)
            or type(state.get("generation_complete")) is not bool
            or not isinstance(state.get("selection"), list)
            or any(not isinstance(item, str) for item in state["selection"])):
        raise ValueError("Invalid saved Optimization round state. " + CONTINUATION_REASON)
    policy = VerificationPolicy.model_validate((settings.get("hybrid") or {}).get("verification_policy") or {}).model_dump()
    return search_problem(settings, algorithm), state, strategy, VERIFICATION_POLICIES[(policy["id"], policy["version"])]


def continuation_assessment(settings, state):
    """History stays readable even when its execution contract is unavailable."""
    try:
        prepare_search(settings, state, False)
    except (ValueError, TypeError, KeyError):
        return {"supported": False, "reason": CONTINUATION_REASON}
    return {"supported": True, "reason": None}


def candidate_snapshots(trials):
    candidates = []
    for trial in sorted(trials, key=lambda item: item.ordinal):
        candidates.append(Candidate(trial.ordinal, deepcopy(trial.variables), trial.fingerprint, trial.id))
    return tuple(candidates)


def observation_snapshots(candidates, evaluations):
    by_id = {candidate.id: candidate for candidate in candidates}
    return tuple(Observation(by_id[item.trial_id], getattr(item, "id", None), item.kind, item.state,
        deepcopy(item.result) if item.state == "succeeded" else None,
        getattr(item, "definition_hash", None), getattr(item, "source_hash", None),
        deepcopy(getattr(item, "source", None)), deepcopy(getattr(item, "error", None)))
        for item in sorted(evaluations, key=lambda item: (by_id[item.trial_id].ordinal, item.kind, getattr(item, "source_hash", "") or "")))


def advance_candidates(candidates, observations, problem, state, strategy, remaining):
    """Observe each completed round once; no strategy sees controller metadata."""
    if candidates:
        if state["completed_round_index"] >= state["round_index"]:
            return state, []
        state["algorithm_state"]["data"] = strategy.observe(problem, state["algorithm_state"]["data"],
            observations, tuple(state["round_ordinals"]))
        strategy.validate(state["algorithm_state"]["data"])
        state["completed_round_index"] = state["round_index"]
    if state["generation_complete"]:
        return state, []
    proposal = strategy.propose(problem, state["algorithm_state"]["data"], candidates, observations, remaining)
    strategy.validate(proposal.state)
    state["algorithm_state"]["data"] = proposal.state
    state["generation_complete"] = proposal.complete
    if not proposal.candidates:
        return state, []
    state.update(round_index=state["round_index"] + bool(candidates), selection=[],
                 round_ordinals=list(proposal.round_ordinals))
    generated = [{"ordinal": item.ordinal, "round_index": state["round_index"], "variables": item.variables,
                  "fingerprint": item.fingerprint} for item in proposal.candidates]
    return state, generated


def advance_solver_search(trials, settings, state, *, evaluations=None):
    problem, state, strategy, _ = prepare_search(settings, state, bool(trials))
    if state.get("termination_reason"):
        return state, [], [], state["termination_reason"]
    problem = replace(problem, mode="solver")
    candidates = candidate_snapshots(trials)
    if not trials:
        state, generated = advance_candidates(candidates, (), problem, state, strategy, settings["max_trials"])
        return state, generated, [], None
    by_ordinal = {trial.ordinal: trial for trial in trials}
    current = [by_ordinal[ordinal] for ordinal in state["round_ordinals"]]
    if any(trial.state != "succeeded" for trial in current):
        return state, [], [], None
    if evaluations is None:
        # The pure compatibility facade can evaluate mathematical fixtures directly.
        observations = tuple(Observation(candidate, None, "solver", by_ordinal[candidate.ordinal].state,
            deepcopy(by_ordinal[candidate.ordinal].result) if by_ordinal[candidate.ordinal].state == "succeeded" else None)
            for candidate in candidates)
    else:
        observations = observation_snapshots(candidates, [item for item in evaluations if item.kind == "solver"])
        ready = {item.ordinal for item in observations if item.state == "succeeded"}
        if any(ordinal not in ready for ordinal in state["round_ordinals"]):
            return state, [], [], None
    state, generated = advance_candidates(candidates, observations, problem, state, strategy, settings["max_trials"] - len(trials))
    if generated:
        return state, generated, [], None
    reason = "candidate_limit" if len(trials) >= settings["max_trials"] else "search_converged"
    state["termination_reason"] = reason
    return state, [], [], reason


def advance_search(trials, evaluations, settings, state, budget):
    """Return state, candidates, Solver verification IDs, and termination reason."""
    problem, state, strategy, select_policy = prepare_search(settings, state, bool(trials))
    if state.get("termination_reason"):
        return state, [], [], state["termination_reason"]
    problem = replace(problem, mode="hybrid")
    candidates = candidate_snapshots(trials)
    if not trials:
        state, generated = advance_candidates(candidates, (), problem, state, strategy, settings["max_trials"])
        return state, generated, [], None
    source_hash = state.get("round_source_hash")
    predicted = {item.trial_id: item for item in evaluations if item.kind == "prediction" and item.state == "succeeded"
                 and (source_hash is None or item.source_hash == source_hash)}
    solved = {item.trial_id: item for item in evaluations if item.kind == "solver"}
    by_id = {trial.id: trial for trial in trials}
    if budget["remaining"] == 0:
        reason = "solver_budget_exhausted" if budget["used"] >= budget["limit"] else None
        if reason:
            state["termination_reason"] = reason
        return state, [], [], reason
    if any(item.state != "succeeded" for item in solved.values()):
        return state, [], [], None
    if any(identity not in solved for identity in state["selection"]):
        return state, [], [], None
    current = [trial for trial in trials if trial.ordinal in state["round_ordinals"]]
    if any(trial.id not in predicted for trial in current):
        return state, [], [], None
    verified = [by_id[key] for key, value in solved.items() if value.state == "succeeded"]
    if not state["selection"]:
        pool = [trial for trial in current if trial.id not in solved]
        chosen = select_policy(pool, predicted, verified, settings["axes"], problem.direction, budget["remaining"])
        if chosen:
            state["selection"] = chosen
            state["selections"] = [*state.get("selections", []), {"round_index": state["round_index"], "trial_ids": chosen}]
            return state, [], chosen, None
    if not verified:
        return state, [], [], None
    observations = observation_snapshots(candidates, [*predicted.values(), *solved.values()])
    state, generated = advance_candidates(candidates, observations, problem, state, strategy, settings["max_trials"] - len(trials))
    if generated:
        return state, generated, [], None
    pool = sorted((trial for trial in trials if trial.id not in solved), key=lambda trial: trial.ordinal)
    if pool and state.get("round_source_hash") is not None and state["selection"]:
        state.update(round_index=state["round_index"] + 1, selection=[],
                     round_ordinals=[trial.ordinal for trial in pool], generation_complete=True)
        return state, [], [], None
    pool = [trial for trial in pool if trial.id in predicted]
    chosen = select_policy(pool, predicted, verified, settings["axes"], problem.direction, budget["remaining"])
    if chosen:
        state["selection"] = chosen
        state["selections"] = [*state.get("selections", []), {"round_index": state["round_index"], "trial_ids": chosen}]
        return state, [], chosen, None
    reason = "candidate_limit" if len(trials) >= settings["max_trials"] else "search_converged"
    state["termination_reason"] = reason
    return state, [], [], reason
