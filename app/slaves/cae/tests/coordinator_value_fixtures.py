from __future__ import annotations

import os

from tests.particle_fixtures import particle_identity

import numpy as np

from app.kernel.api import (
    BundleValue, FieldValue, ParticleSetValue, QuantityArrayValue, SolverImplementation,
    SolverInvocation, SolverResult, StatePatch, UnstructuredMeshValue,
)


async def produce(invocation: SolverInvocation) -> SolverResult:
    original = np.array([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]])
    mesh = UnstructuredMeshValue(
        original + [1., 2., 3.], {"tetra4": np.array([[0, 1, 2, 3]], dtype=np.int64)},
        "m", identity="moved-mesh", metadata={"sourceIdentity": "original-mesh"},
    )
    field = FieldValue(mesh, "node", "thermodynamics.Temperature", "K", np.arange(300., 304.))
    particles = ParticleSetValue(
        np.array([[0., 1., 2.], [3., 4., 5.]]), "m",
        identity="particles",
     **particle_identity())
    samples = BundleValue("test/samples@1", {
        "temperature": FieldValue(particles, "particle", "thermodynamics.Temperature", "K", np.array([310., 320.])),
    })
    assert np.array_equal(original[0], [0., 0., 0.])
    return SolverResult(
        StatePatch().put("field", field).put("samples", samples),
        {"field": field, "samples": samples}, {"pid": os.getpid()},
    )


async def consume(invocation: SolverInvocation) -> SolverResult:
    field = invocation.inputs["field"].value
    samples = invocation.inputs["samples"].value
    assert isinstance(field, FieldValue)
    assert isinstance(field.domain, UnstructuredMeshValue)
    assert field.domain.identity == "moved-mesh"
    assert field.domain.metadata["sourceIdentity"] == "original-mesh"
    assert np.array_equal(field.domain.points[0], [1., 2., 3.])
    assert np.array_equal(field.domain.cells["tetra4"], [[0, 1, 2, 3]])
    assert field.location == "node" and field.unit == "K" and field.domain.unit == "m"
    assert isinstance(invocation.state["field"], FieldValue)
    assert isinstance(samples, BundleValue)
    particle_field = samples.members["temperature"]
    assert isinstance(particle_field.domain, ParticleSetValue)
    assert np.array_equal(particle_field.domain.particle_ids, [0, 1])
    assert particle_field.location == "particle"
    return SolverResult(
        artifacts={"answer": float(field.values.sum() + particle_field.values.sum())},
        observations={"pid": os.getpid()},
    )


producer = SolverImplementation(abi_version=3, run=produce)
consumer = SolverImplementation(abi_version=3, run=consume)


async def produce_particles(invocation: SolverInvocation) -> SolverResult:
    count = 50000  # Velocity must cross the actual mmap transport threshold.
    particles = ParticleSetValue(np.zeros((count, 3)), "m", {
        "velocity": QuantityArrayValue("kinematics.Velocity", "m.s-1", np.ones((count, 3)),
                                       np.eye(3), ("x", "y", "z")),
        "mass": QuantityArrayValue("Mass", "kg", np.ones(count)),
    }, identity="native-particles", **particle_identity(count))
    return SolverResult(
        state_patch=StatePatch().put("particles", particles).put("velocityView", particles.attribute_field("velocity")),
        exports={"particles": particles},
    )


async def consume_particles(invocation: SolverInvocation) -> SolverResult:
    particles = invocation.inputs["particles"].value
    assert isinstance(particles, ParticleSetValue)
    assert particles.attributes["velocity"].quantity_kind == "kinematics.Velocity"
    assert particles.materials[0]["source"] == "experiment"
    assert particles.particle_ids[-1] == 49999
    velocity = particles.attributes["velocity"].values
    assert not velocity.flags.writeable
    assert np.array_equal(invocation.state["particles"].attributes["velocity"].values, velocity)
    field = invocation.state["velocityView"]
    assert isinstance(field, FieldValue) and not field.values.flags.writeable
    assert np.shares_memory(field.values, velocity)
    assert np.shares_memory(field.domain.positions, particles.positions)
    assert not field.domain.attributes and field.domain.materials == particles.materials
    return SolverResult(artifacts={"answer": float(velocity.sum())})


async def invalid_particle_trial(invocation: SolverInvocation) -> SolverResult:
    from dataclasses import replace

    particles = invocation.inputs["particles"].value
    invalid = replace(particles, attributes={**particles.attributes, "velocity": QuantityArrayValue(
        "kinematics.Velocity", "s", np.zeros_like(particles.attributes["velocity"].values),
        np.eye(3), ("x", "y", "z"))})
    return SolverResult(state_patch=StatePatch().put("particles", invalid), exports={"particles": invalid})


particle_producer = SolverImplementation(abi_version=3, run=produce_particles)
particle_consumer = SolverImplementation(abi_version=3, run=consume_particles)
particle_invalid_trial = SolverImplementation(abi_version=3, run=invalid_particle_trial)
