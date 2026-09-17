"""Select accepted history samples and map physical node IDs."""

import numpy as np


def history_members(model, solution, node_ids=None, scope="cumulative"):
    """Flatten accepted samples; final selects the last sample of this invocation.

    latest-window selects the last accepted chunk. Automatic mesh visualization
    uses cumulative history independently of the requested Box Grid scope.
    """
    if scope not in ("cumulative", "latest-window", "final"):
        raise ValueError("history scope must be cumulative, latest-window or final")
    stored_nodes = np.arange(len(model.points)) if model.history_nodes is None else model.history_nodes
    stored_ids = model.node_ids[stored_nodes]
    requested = stored_ids if node_ids is None else np.asarray(node_ids)
    if len(np.unique(requested)) != len(requested):
        raise ValueError("History node IDs must be unique")
    if np.array_equal(requested, stored_ids):
        selection = slice(None)
    else:
        order = np.argsort(stored_ids)
        positions = np.searchsorted(stored_ids[order], requested)
        if np.any(positions >= len(order)) or not np.array_equal(stored_ids[order[positions]], requested):
            raise ValueError("History must contain every physical mesh node; requested IDs are absent")
        selection = order[positions]
    members = {"nodeIds": np.asarray(requested, dtype=np.int32)}
    nodal = {"displacement", "rotation", "velocity", "reaction", "reactionMoment"}
    for name, chunks in solution.history.items():
        chunks = chunks[-1:] if scope in ("latest-window", "final") else chunks
        selected = [np.asarray(chunk)[:, selection] if name in nodal else np.asarray(chunk) for chunk in chunks]
        members[name] = selected[-1][-1:] if scope == "final" else selected[0] if len(selected) == 1 else np.concatenate(selected, axis=0)
    return members
