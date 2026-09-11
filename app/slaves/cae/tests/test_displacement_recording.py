"""Output/recording checks with synthetic history; no Solver execution."""
from types import SimpleNamespace

import numpy as np
import pytest

from app.kernel.api import UnstructuredMeshValue
from app.kernel.catalog import solver_catalog
from app.kernel.coordinator.contracts import validate_artifact_payload
from app.kernel.resources import ArtifactStore, ResourceStore
from app.kernel.transport.recording import materialize_record_value
from app.kernel.transport.tensor import encode_recorded_data
from app.solvers.structural_mechanics import outputs


@pytest.mark.parametrize("samples", [2, 1000])
def test_complete_displacement_history_recording(monkeypatch, samples):
    ids = np.array([10, 20, 30, 40], dtype=np.int32)
    domain = UnstructuredMeshValue(np.zeros((4, 3)), {"tet4": np.array([[0, 1, 2, 3]], dtype=np.int32)}, "m", "domain", {"nodeIds": ids})
    model = SimpleNamespace(points=domain.points, physical_node_count=4, node_ids=ids, history_nodes=None, result_requests={})
    config = {"parameters": {"analysis": "transient"}, "outputs": [{"methodId": "fea.displacement-history", "key": "anything"}]}
    outputs.configure_history(model, config["outputs"])
    np.testing.assert_array_equal(model.history_nodes, [0, 1, 2, 3])
    # Store history in a different order to exercise ID mapping at the output boundary.
    model.history_nodes = np.array([2, 0, 3, 1])
    times = np.arange(samples, dtype=float) * .001
    displacement = np.broadcast_to(ids[model.history_nodes][None, :, None], (samples, 4, 3)).astype(float).copy()
    solution = SimpleNamespace(history={"times": [times], "displacement": [displacement]})
    monkeypatch.setattr(outputs, "_physical_domain", lambda model: (domain, [0]))
    monkeypatch.setattr(outputs, "interface_members", lambda model: {})
    descriptor = solver_catalog.descriptor("structural-mechanics", "4.0.0")
    definition = next(item for item in descriptor["methods"]["outputs"] if item["methodId"] == "fea.displacement-history")
    value = outputs.build_outputs(config, descriptor, model, solution)["anything"]
    validate_artifact_payload(value, definition["data"], "anything")
    np.testing.assert_array_equal(value.members["values"]["value"][0, :, 0], ids)
    schema = {**definition["data"]["members"], "field": {
        "values": definition["data"]["members"]["field"],
        "domain": {"metadata": {"nodeIds": {"dtype": "int32", "axes": [{"name": "node"}]}}},
    }}
    resources = ResourceStore()
    artifacts = ArtifactStore(resources)
    leases = []
    try:
        handle = artifacts.publish(value, producer_task="solid", solver_name="structural-mechanics", solver_version="4.0.0", output_name="anything", artifact_type=definition["artifactType"], state_revision=1)
        recorded = materialize_record_value(handle, schema, resources=resources, artifacts=artifacts, owner="record", leases=leases)
        encoded, attachments, _ = encode_recorded_data("motion", schema, recorded, 1)
        assert encoded["values"]["shape"] == [samples, 4, 3]
        assert encoded["values"]["axes"][1]["ticks"] == ids.tolist()
        assert bool(attachments) == (samples == 1000)
    finally:
        for lease in leases:
            resources.release(lease)
        artifacts.close()
        resources.close()
    model.history_nodes = np.array([0, 1])
    with pytest.raises(ValueError, match="every physical mesh node"):
        outputs.build_outputs(config, descriptor, model, solution)
