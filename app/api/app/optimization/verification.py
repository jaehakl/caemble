"""Pure Solver verification policies; selection never submits work."""
from types import SimpleNamespace

from optimization.algorithm import trial_rank


def select_verifications(candidates, predictions, verified, axes, direction, remaining):
    """Best predicted candidate plus maximin exploration in normalized Vars space."""
    if not candidates or remaining <= 0:
        return []
    first = min(candidates, key=lambda trial: trial_rank(
        SimpleNamespace(result=predictions[trial.id].result, ordinal=trial.ordinal), direction))
    if remaining == 1 or len(candidates) == 1:
        return [first.id]

    def coordinates(trial):
        result = []
        for axis in axes:
            if axis["fixed"] or axis["min"] == axis["max"]:
                continue
            value = trial.variables[axis["name"]]
            for index in axis["indices"]:
                value = value[index]
            scale = max(abs(axis["min"]), abs(axis["max"]), 1)
            result.append((value / scale - axis["min"] / scale) / (axis["max"] / scale - axis["min"] / scale))
        return result

    references = [coordinates(trial) for trial in [*verified, first]]

    def distance(trial):
        position = coordinates(trial)
        return min(sum((x - y) ** 2 for x, y in zip(position, reference)) for reference in references)

    second = min((trial for trial in candidates if trial.id != first.id), key=lambda trial: (-distance(trial), trial.ordinal))
    return [first.id, second.id]


VERIFICATION_POLICIES = {("best_predicted_maximin", 1): select_verifications}
