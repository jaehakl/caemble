
import numpy as np
import pytest
import torch

from app.kernel.api import SolverResult, StatePatch
from app.kernel.api.errors import CaeError
from app.kernel.catalog import SolverCatalog
from app.kernel.coordinator.commit import commit_result
from app.kernel.coordinator.plan import TaskSpec
from app.kernel.execution import SolverExecutionTransaction
from app.kernel.resources import ArtifactStore, ResourceStore, StateStore
from app.kernel.transport.recording import materialize_record_value
from app.kernel.transport.tensor import decode_attachment_tensors, encode_recorded_data
from app.solvers.fdtd.detectors import DetectorRegion, SpectralDetector, TimeDetector
from tests.test_box_grid_outputs import grid
from app.methods.fields.box_grid import RectilinearSampler


@pytest.mark.parametrize("kind", ["electric", "magnetic"])
@pytest.mark.parametrize("spectral", [False, True])
@pytest.mark.parametrize("width", [2, 4000])
def test_fdtd_field_commit_and_record_roundtrip(kind, spectral, width):
    catalog = SolverCatalog.discover()
    descriptor = catalog.descriptor("fdtd", "5.0.0")
    method = next(output for output in descriptor["methods"]["outputs"]
                  if output["methodId"] == f"fdtd.{'spectral' if spectral else 'time'}-{kind}-field")
    artifact_type = catalog.artifact_type(method["artifactType"])
    assert artifact_type["payloadKind"] == "tensor"
    spec = TaskSpec(
        name="reference", task={"kernel": {"name": "fdtd", "version": "5.0.0"}},
        descriptor=descriptor, locator=catalog.locator("fdtd", "5.0.0"), abi_version=3,
        output_specs={"scattered": method}, scene={}, material_snapshot={},
        artifact_payload_kinds={method["artifactType"]: artifact_type["payloadKind"]},
    )
    probe = grid(shape=(1, 1, width), origin=(-.357e-6,-1e-8,-1.1e-6), size=(.004e-6,2e-8,2.2e-6))
    sampler = RectilinearSampler.prepare(probe.axes, probe.points(), ((0,1),)*3)
    region = DetectorRegion(sampler, probe, method["data"])
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
    assert field["value"].shape == (1,1,width,1 if spectral else 2,2 if spectral else 1,2 if spectral else 1,3)
    assert field["boxGrid"]["gridShape"] == [1,1,width]
    resources = ResourceStore()
    states = StateStore(resources)
    artifacts = ArtifactStore(resources)
    leases = []
    try:
        # Box metadata is mandatory at the actual commit boundary.
        rejected = SolverExecutionTransaction(SolverResult(StatePatch(), {"scattered": {"value": values}}))
        with pytest.raises(CaeError, match="Box"):
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
        assert encoded["shape"] == list(field["value"].shape)
        assert byte_length == field["value"].nbytes
        assert bool(attachments) == (width == 4000)
        assert encoded["axes"][4 if spectral else 3]["ticks"] == samples.tolist()
        assert encoded["boxGrid"]["origin"] == probe.geometry["origin"]
        if attachments:
            decoded = decode_attachment_tensors({"dtype": method["data"]["dtype"], "value": encoded}, attachments)["value"]
        else:
            decoded = np.asarray(encoded["storage"]["value"], dtype=np.float32)
        np.testing.assert_array_equal(decoded, field["value"])
        if spectral:
            restored = decoded[...,0,:] * np.exp(1j * decoded[...,1,:])
            expected = np.moveaxis(values, 0, 3).reshape(restored.shape)
            np.testing.assert_allclose(restored, expected, rtol=3e-7, atol=2e-6)
    finally:
        for lease in reversed(leases):
            resources.release(lease)
        artifacts.close()
        states.close()
        assert resources.stats().resource_count == 0
        resources.close()
