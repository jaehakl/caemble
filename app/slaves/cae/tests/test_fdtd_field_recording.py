from dataclasses import replace

import numpy as np
import pytest
import torch

from app.kernel.api import FieldValue, SolverResult, StatePatch
from app.kernel.api.errors import CaeError
from app.kernel.catalog import SolverCatalog
from app.kernel.coordinator.commit import commit_result
from app.kernel.coordinator.plan import TaskSpec
from app.kernel.execution import SolverExecutionTransaction
from app.kernel.resources import ArtifactStore, ResourceStore, StateStore
from app.kernel.transport.recording import materialize_record_value
from app.kernel.transport.tensor import decode_attachment_tensors, encode_recorded_data
from app.solvers.fdtd.detectors import DetectorRegion, SpectralDetector, TimeDetector


@pytest.mark.parametrize("kind", ["electric", "magnetic"])
@pytest.mark.parametrize("spectral", [False, True])
@pytest.mark.parametrize("width", [2, 4000])
def test_fdtd_field_commit_and_record_roundtrip(kind, spectral, width):
    catalog = SolverCatalog.discover()
    descriptor = catalog.descriptor("fdtd", "4.0.0")
    method = next(output for output in descriptor["methods"]["outputs"]
                  if output["methodId"] == f"fdtd.{'spectral' if spectral else 'time'}-{kind}-field")
    artifact_type = catalog.artifact_type(method["artifactType"])
    assert artifact_type["payloadKind"] == "field"
    spec = TaskSpec(
        name="reference", task={"kernel": {"name": "fdtd", "version": "4.0.0"}},
        descriptor=descriptor, locator=catalog.locator("fdtd", "4.0.0"), abi_version=3,
        output_specs={"scattered": method}, scene={}, material_snapshot={},
        artifact_payload_kinds={method["artifactType"]: artifact_type["payloadKind"]},
    )
    ticks = (np.array([-0.355e-6]), np.array([0.0]), np.linspace(-1e-6, 1e-6, width))
    bounds = ((-0.357e-6, -0.353e-6), (-1e-8, 1e-8), (-1.1e-6, 1.1e-6))
    region = DetectorRegion(np.array([0]), np.array([0]), np.arange(width), ticks, bounds)
    samples = np.array([299792458 / 1000e-9, 299792458 / 1500e-9]) if spectral else np.array([0.0, 2e-15])
    values = np.arange(2 * width * 3, dtype=np.float32).reshape(2, 1, 1, width, 3)
    if spectral:
        values = (values - 2j * values).astype(np.complex64)
        detector = SpectralDetector("scattered", method["artifactType"], kind, region, samples, torch.device("cpu"))
        detector.accumulator = torch.from_numpy(values)
        detector.sample_count = 1
    else:
        detector = TimeDetector("scattered", method["artifactType"], kind, region, 1)
        detector.samples = list(values)
        detector.times = samples.tolist()
    field = detector.artifact()
    assert isinstance(field, FieldValue)
    assert field.domain.shape == (1, 1, width)
    assert field.domain.unit == "m"
    assert field.components == tuple(("E" if kind == "electric" else "H") + axis for axis in "xyz")
    resources = ResourceStore()
    states = StateStore(resources)
    artifacts = ArtifactStore(resources)
    leases = []
    try:
        # The old dictionary result must still fail the actual Catalog field contract.
        rejected = SolverExecutionTransaction(SolverResult(StatePatch(), {"scattered": {"value": values}}))
        with pytest.raises(CaeError, match="must be a FieldValue"):
            commit_result(rejected, spec, states.empty, resources=resources, states=states, artifacts=artifacts)
        assert rejected.status == "rolled_back"
        transaction = SolverExecutionTransaction(SolverResult(StatePatch(), {"scattered": field}))
        _, handles = commit_result(transaction, spec, states.empty, resources=resources, states=states, artifacts=artifacts)
        assert transaction.status == "committed"
        handle = handles["scattered"]
        assert handle.provenance.producer_task == "reference" and handle.provenance.output_name == "scattered"
        recorded = materialize_record_value(handle, method["data"], resources=resources, artifacts=artifacts, owner="test-record", leases=leases)
        artifacts.release(handle)
        encoded, attachments, byte_length = encode_recorded_data("scattered", method["data"], recorded, 1)
        assert encoded["shape"] == [2, 1, 1, width, 3]
        assert byte_length == values.nbytes
        assert bool(attachments) == (width == 4000)
        assert encoded["axes"][0]["ticks"] == samples.tolist()
        assert encoded["axes"][0]["unit"] == ("Hz" if spectral else "s")
        for index in range(3):
            assert encoded["axes"][index + 1]["ticks"] == ticks[index].tolist()
            assert encoded["axes"][index + 1]["bounds"] == list(bounds[index])
        if attachments:
            decoded = decode_attachment_tensors({"dtype": method["data"]["dtype"], "value": encoded}, attachments)["value"]
        elif spectral:
            raw = np.asarray(encoded["storage"]["value"], dtype=object)
            decoded = np.array([complex(v["re"], v["im"]) for v in raw.flat], dtype=np.complex64).reshape(raw.shape)
        else:
            decoded = np.asarray(encoded["storage"]["value"], dtype=np.float32)
        np.testing.assert_array_equal(decoded, values)
        invalid = replace(field, metadata={"sampleAxes": [{"name": "wrong", "unit": "m", "ticks": samples}]})
        with pytest.raises(CaeError, match="meaning differs"):
            materialize_record_value(invalid, method["data"], resources=resources, artifacts=artifacts, owner="test", leases=[])
    finally:
        for lease in reversed(leases):
            resources.release(lease)
        artifacts.close()
        states.close()
        assert resources.stats().resource_count == 0
        resources.close()
