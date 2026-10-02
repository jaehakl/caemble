"""Physical particle values preserve their meaning and storage across runtime boundaries."""

import gc
from dataclasses import replace
from types import SimpleNamespace

import numpy as np
import pytest

from app.kernel.api import BundleValue, FieldValue, ParticleSetValue, QuantityArrayValue, StructuredGridValue
from app.kernel.api.world import interaction_model_by_name, material_model_by_name
from app.kernel.coordinator.contracts import validate_artifact_payload
from app.kernel.coordinator.plan import RunPlan, TaskSpec
from app.kernel.coordinator.simulation import SimulationApi
from app.kernel.api.errors import CaeError
from app.kernel.execution import MmapPayloadCodec
from app.kernel.resources import ArtifactStore, BufferStore, ResourceStore, ResourceValidationError
from app.kernel.transport.recording import materialize_record_value
from tests.particle_fixtures import particle_identity


def particles():
    return ParticleSetValue(np.array([[0., 0., 0.], [1., 0., 0.]]), "m", {
        "velocity": QuantityArrayValue("kinematics.Velocity", "m.s-1", np.arange(6.).reshape(2, 3),
                                       np.eye(3), ("x", "y", "z")),
        "mass": QuantityArrayValue("Mass", "kg", np.array([2., 3.])),
    }, identity="test-particles", metadata={"time": 0.5}, **particle_identity())


def test_particle_field_view_shares_storage_without_freezing_solver_workspace():
    value = particles()
    field = value.attribute_field("velocity")
    assert not field.values.flags.writeable and not field.domain.positions.flags.writeable
    assert value.attributes["velocity"].values.flags.writeable and value.positions.flags.writeable
    assert not field.domain.attributes
    assert np.shares_memory(field.values, value.attributes["velocity"].values)
    resources = ResourceStore()
    try:
        root = resources.ingest(BundleValue("test/particles", {"particles": value, "velocity": field}))
        restored = resources.resolve(root)
        particle_value = restored.members["particles"]
        assert particle_value.attributes["velocity"].values is restored.members["velocity"].values
        assert particle_value.positions is restored.members["velocity"].domain.positions
        with pytest.raises(TypeError):
            particle_value.materials[0]["name"] = "changed"
        with pytest.raises(ValueError):
            particle_value.particle_ids[0] = 3
    finally:
        resources.close()


def test_particle_quantity_mmap_reuses_backing_and_honors_last_lease():
    buffers, resources = BufferStore(), ResourceStore()
    codec = MmapPayloadCodec(buffers, array_threshold=1)
    try:
        value = particles()
        transaction = codec.begin_invocation()
        decoded = transaction.decode(transaction.encode({"particles": value, "field": value.attribute_field("velocity")}))
        roots = resources.ingest_many(tuple(decoded.values()), copy_arrays=False)
        leases = [resources.acquire(root) for root in roots]
        transaction.commit()
        first = resources.materialize(roots[0], copy_arrays=False)
        view = resources.materialize(roots[1], copy_arrays=False)
        assert buffers.descriptor_for(first.attributes["velocity"].values).buffer_id == buffers.descriptor_for(view.values).buffer_id
        files = buffers.files()
        second = codec.begin_invocation()
        forwarded = second.decode(second.encode(first))
        second.commit()
        assert buffers.files() == files
        np.testing.assert_array_equal(forwarded.particle_ids, [0, 1])
        assert forwarded.materials[0]["source"] == "experiment"
        resources.release(leases[0])
        np.testing.assert_array_equal(resources.resolve(roots[1]).values, np.arange(6.).reshape(2, 3))
        resources.release(leases[1])
        assert resources.stats().resource_count == 0
        del decoded, first, view, forwarded
        gc.collect()
        assert buffers.files() == ()
    finally:
        resources.close()
        buffers.close()


def test_inline_particle_field_preserves_readonly_views_and_shared_backing():
    buffers = BufferStore()
    codec = MmapPayloadCodec(buffers)
    try:
        value = particles()
        invocation = codec.begin_invocation()
        decoded = invocation.decode(invocation.encode({"particles": value, "field": value.attribute_field("velocity")}))
        invocation.commit()
        quantity = decoded["particles"].attributes["velocity"].values
        field = decoded["field"].values
        assert not buffers.files()
        assert quantity.flags.writeable and not field.flags.writeable
        assert np.shares_memory(quantity, field)
        np.testing.assert_array_equal(quantity, field)
        with pytest.raises(ValueError):
            field[0, 0] = 3
        quantity[0, 0] = 42
        assert field[0, 0] == 42
    finally:
        buffers.close()


@pytest.mark.parametrize("dtype", [np.float64, np.complex64])
def test_scalar_quantity_explicit_components_share_the_field_contract(dtype):
    components = ("xx", "yy", "zz", "xy", "yz", "xz")
    quantity = QuantityArrayValue("Pressure", "Pa", np.arange(12).reshape(2, 6).astype(dtype),
                                  components=components)
    value = replace(particles(), attributes={"stress": quantity})
    resources = ResourceStore()
    try:
        restored = resources.resolve(resources.ingest(BundleValue("fixture/scalar-components", {
            "particles": value, "field": value.attribute_field("stress"),
        })))
        field = restored.members["field"]
        attribute = restored.members["particles"].attributes["stress"]
        assert field.quantity_kind == attribute.quantity_kind == "Pressure"
        assert field.components == attribute.components == components
        assert field.values is attribute.values
        np.testing.assert_array_equal(field.values, quantity.values)
        contract = {"quantityKind": "Pressure", "unit": "Pa", "dtype": np.dtype(dtype).name,
                    "tensorOrder": 0, "axes": [{"name": "particle"}, {"name": "component", "length": 6}]}
        validate_artifact_payload(quantity, contract, "attribute")
        validate_artifact_payload(field, contract, "field")
        with pytest.raises(ValueError, match="trailing dimension"):
            resources.ingest(replace(quantity, values=np.zeros((2, 5), dtype=dtype)))
        with pytest.raises(ValueError, match="distinct|unique"):
            replace(quantity, components=("xx",) * 6)
    finally:
        resources.close()


def test_compact_tensor_quantity_and_field_use_one_native_component_axis():
    quantity = QuantityArrayValue("mechanics.StressTensor", "Pa", np.zeros((2, 6)),
                                  components=("xx", "yy", "zz", "xy", "yz", "xz"))
    field = replace(particles(), attributes={"stress": quantity}).attribute_field("stress")
    contract = {"quantityKind": quantity.quantity_kind, "unit": "Pa", "dtype": "float64",
                "tensorOrder": 2, "basis": np.eye(3).tolist(), "axes": [{"name": "particle"}]}
    validate_artifact_payload(quantity, contract, "quantity")
    validate_artifact_payload(field, contract, "field")


@pytest.mark.parametrize("quantity,unit", [("mechanics.DeformationGradient", "1"), ("mechanics.FirstPiolaStress", "Pa")])
def test_two_configuration_tensors_require_all_nine_components(quantity, unit):
    resources = ResourceStore()
    try:
        compact = QuantityArrayValue(quantity, unit, np.zeros((2, 6)), components=("xx", "yy", "zz", "xy", "yz", "xz"))
        with pytest.raises(ValueError, match="component count"):
            resources.ingest(compact)
        values = np.arange(18.).reshape(2, 3, 3)
        for components, array in ((None, values), (tuple(a + b for a in "xyz" for b in "xyz"), values.reshape(2, 9))):
            tensor = QuantityArrayValue(quantity, unit, array, components=components,
                                        metadata={"rowConfiguration": "current", "columnConfiguration": "reference"})
            restored = resources.resolve(resources.ingest(tensor))
            np.testing.assert_array_equal(restored.values, array)
            assert restored.metadata == tensor.metadata
    finally:
        resources.close()


@pytest.mark.parametrize("quantity,unit,components,match", [
    ("kinematics.Velocity", "m.s-1", ("x", "y"), "component count"),
    ("mechanics.StressTensor", "Pa", ("xx", "yy", "zz", "xy", "yz"), "component count"),
    ("mechanics.StressTensor", "Pa", ("xx", "yy", "zz", "xy", "yx", "xz"), "independent symmetric"),
])
def test_physical_tensor_components_cannot_use_arbitrary_scalar_channel_counts(quantity, unit, components, match):
    value = QuantityArrayValue(quantity, unit, np.zeros((2, len(components))), components=components)
    resources = ResourceStore()
    try:
        with pytest.raises(ValueError, match=match):
            resources.ingest(value)
        with pytest.raises(ValueError, match=match):
            resources.ingest(replace(particles(), attributes={"attribute": value}).attribute_field("attribute"))
        assert resources.stats().resource_count == 0
    finally:
        resources.close()


@pytest.mark.parametrize("change,match", [
    ({"unit": "s"}, "incompatible"),
    ({"quantity_kind": "not.registered"}, "not registered"),
    ({"components": ("x", "y")}, "trailing dimension"),
    ({"values": np.zeros((3, 3))}, "first dimension"),
    ({"basis": np.ones((3, 3))}, "orthonormal"),
])
def test_particle_and_field_share_quantity_validation(change, match):
    value = particles()
    quantity = replace(value.attributes["velocity"], **change)
    resources = ResourceStore()
    try:
        with pytest.raises(ValueError, match=match):
            resources.ingest(replace(value, attributes={"velocity": quantity}))
        if "values" not in change:
            field = FieldValue(value, "particle", quantity.quantity_kind, quantity.unit, quantity.values,
                               quantity.basis, quantity.components)
            with pytest.raises(ValueError, match=match):
                resources.ingest(field)
        assert resources.stats().resource_count == 0
    finally:
        resources.close()


@pytest.mark.parametrize("change,match", [
    ({"particle_ids": np.array([1, 1], dtype=np.int64)}, "unique"),
    ({"particle_ids": np.array([1, 2], dtype=np.int16)}, "int32 or int64"),
    ({"material_indices": np.array([0, 1])}, "material table"),
    ({"positions": np.zeros((2, 2))}, "particle, 3"),
    ({"positions": np.zeros((2, 3), dtype=np.complex128)}, "particle, 3"),
    ({"unit": "s"}, "length unit"),
])
def test_particle_identity_and_coordinates_are_validated_transactionally(change, match):
    resources = ResourceStore()
    try:
        with pytest.raises(ResourceValidationError, match=match):
            resources.ingest(replace(particles(), **change))
        assert resources.stats().resource_count == 0
    finally:
        resources.close()


@pytest.mark.parametrize("dtype", [np.int32, np.int64])
def test_particle_ids_preserve_the_declared_integer_dtype(dtype):
    resources = ResourceStore()
    try:
        value = replace(particles(), particle_ids=np.array([11, 12], dtype=dtype))
        restored = resources.resolve(resources.ingest(value))
        assert restored.particle_ids.dtype == dtype
        np.testing.assert_array_equal(restored.particle_ids, value.particle_ids)
    finally:
        resources.close()


def test_native_particle_contract_and_record_projection_preserve_metadata():
    value = particles()
    contract = {"resourceKind": "particleSet", "coordinateUnit": "m", "coordinateFrame": "world", "attributes": {
        "velocity": {"quantityKind": "kinematics.Velocity", "unit": "m.s-1", "dtype": "float64", "axes": [{}], "tensorOrder": 1, "basis": np.eye(3).tolist()},
        "mass": {"quantityKind": "Mass", "unit": "kg", "dtype": "float64", "axes": [{}]},
    }}
    validate_artifact_payload(value, contract, "particles")
    with pytest.raises(ValueError, match="attributes"):
        validate_artifact_payload(replace(value, attributes={}), contract, "particles")
    resources, leases = ResourceStore(), []
    artifacts = ArtifactStore(resources)
    try:
        handle = artifacts.publish(value, producer_task="particles", solver_name="fixture", solver_version="1.0.0",
                                   output_name="particles", artifact_type="test/particles@1", state_revision=1)
        schema = {"particleIds": {"dtype": "int64", "axes": [{}]}, "coordinateFrame": {"dtype": "string"},
                  "attributes": {"mass": {"quantity": {"dtype": "string"}, "valueUnit": {"dtype": "string"},
                                           "values": {"dtype": "float64", "axes": [{}]}}}}
        projected = materialize_record_value(handle, schema, resources=resources, artifacts=artifacts, owner="test", leases=leases)
        assert projected["coordinateFrame"] == "world"
        assert projected["attributes"]["mass"]["quantity"] == "Mass"
        assert projected["attributes"]["mass"]["valueUnit"] == "kg"
        np.testing.assert_array_equal(projected["attributes"]["mass"]["values"]["value"], [2., 3.])
        artifacts.release(handle)
        for lease in leases:
            resources.release(lease)
        assert resources.stats().resource_count == 0
    finally:
        artifacts.close()
        resources.close()


def test_material_reference_lookup_respects_selected_models_and_catalog_defaults():
    explicit = {"model": "fixture", "parameters": {"value": 1}}
    default = {"model": "default-fixture", "parameters": {"value": 2}}
    world = {"materials": {"experiment": {"A": {"models": {"selected": explicit}}}},
             "materialSelections": {"body": {"A": {"density": "selected"}}},
             "interactionSelections": {"contact": [{"between": ["A", "B"], "interaction": None, "models": {"law": None}}]},
             "interactionDefaults": {"contact": {"law": default}}}
    assert material_model_by_name(world, "A", "body", "density") is explicit
    assert interaction_model_by_name(world, "B", "A", "contact", "law") is default
    world["interactionSelections"]["contact"][0]["models"]["law"] = "missing"
    with pytest.raises(KeyError):
        interaction_model_by_name(world, "A", "B", "contact", "law")


@pytest.mark.asyncio
async def test_native_particles_cross_children_and_failed_trial_preserves_state():
    data = {"resourceKind": "particleSet", "coordinateUnit": "m", "coordinateFrame": "world", "attributes": {
        "velocity": {"quantityKind": "kinematics.Velocity", "unit": "m.s-1", "dtype": "float64", "axes": [{}], "tensorOrder": 1},
        "mass": {"quantityKind": "Mass", "unit": "kg", "dtype": "float64", "axes": [{}]},
    }}
    export = {"particles": {"artifactType": "fixture/particles@1", "payloadKind": "particle-set", "category": "exports", "data": data}}
    port = {"particles": {"artifactTypes": ["fixture/particles@1"], "minimumOccurrences": 1,
                          "maximumOccurrences": 1, "data": data, "payloadKind": "particle-set"}}
    specs = {}
    for name, locator, inputs, outputs in (
        ("producer", "particle_producer", {}, export),
        ("consumer", "particle_consumer", port, {"answer": {"artifactType": "fixture/answer@1", "data": {"dtype": "float64"}}}),
        ("invalid", "particle_invalid_trial", port, export),
    ):
        specs[name] = TaskSpec(name, {"kernel": {"name": f"fixture-{name}", "version": "1.0.0"}, "config": {}},
                               {"inputPorts": inputs, "observations": {}}, f"tests.coordinator_value_fixtures:{locator}",
                               3, outputs, {}, {})
    plan = RunPlan(specs, {}, {}, {})

    async def progress(value):
        pass

    sim = SimulationApi(SimpleNamespace(plan=plan, run_id="particle-native", max_run_seconds=30, trace=[], progress=progress))
    try:
        produced = await sim.run(plan.tasks["producer"])
        files = sim._buffers.files()
        resources = sim._resources.stats().resource_count
        with pytest.raises(CaeError, match="quantity or unit"):
            await sim.run(plan.tasks["invalid"], state=produced["state"], inputs=produced["artifacts"])
        assert sim._resources.stats().resource_count == resources
        assert sim._buffers.files() == files
        consumed = await sim.run(plan.tasks["consumer"], state=produced["state"], inputs=produced["artifacts"])
        assert sim._artifacts.materialize(consumed["artifacts"]["answer"]) == 150000.
        sim.release((produced, consumed))
    finally:
        sim.close()
