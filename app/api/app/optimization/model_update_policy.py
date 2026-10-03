"""Pure admission decisions for bounded, round-boundary model rebuilding."""
from dataclasses import dataclass

from optimization.configuration import ModelUpdateConfig


@dataclass(frozen=True)
class UpdateDecision:
    reason: str
    timeout_seconds: float = 0


def decide_update(config: ModelUpdateConfig, *, running: bool, next_round: bool,
                  round_index: int, last_request_round: int | None, busy: bool,
                  pending_model: bool, new_measurements: int, attempts: int,
                  elapsed_seconds: float) -> UpdateDecision:
    """A decision neither advances search state nor consumes a training budget."""
    if not running:
        return UpdateDecision("not_running")
    if not next_round:
        return UpdateDecision("awaiting_round")
    if busy:
        return UpdateDecision("training_busy")
    if pending_model:
        return UpdateDecision("awaiting_adoption")
    if last_request_round == round_index:
        return UpdateDecision("round_already_requested")
    if attempts >= config.max_updates:
        return UpdateDecision("update_limit")
    remaining = config.total_timeout_seconds - elapsed_seconds
    if remaining <= 0:
        return UpdateDecision("time_limit")
    if new_measurements < config.min_new_measurements:
        return UpdateDecision("insufficient_results")
    return UpdateDecision("request", min(config.update_timeout_seconds, remaining))
