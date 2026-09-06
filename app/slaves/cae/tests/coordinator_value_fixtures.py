from __future__ import annotations

import os

import numpy as np

from app.runtime_kernel.api import (
    BundleValue, FieldValue, ParticleSetValue, SolverImplementation,
    SolverInvocation, SolverResult, StatePatch, UnstructuredMeshValue,
)


async def produce(invocation: SolverInvocation) -> SolverResult:
    original = np.array([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]])
    mesh = UnstructuredMeshValue(
        original + [1., 2., 3.], {"tetra4": np.array([[0, 1, 2, 3]], dtype=np.int64)},
        "m", identity="moved-mesh", metadata={"sourceIdentity": "original-mesh"},
    )
    field = FieldValue(mesh, "node", "TestTemperature", "K", np.arange(300., 304.))
    particles = ParticleSetValue(
        np.array([[0., 1., 2.], [3., 4., 5.]]), "m",
        attributes={"id": np.array([11, 12], dtype=np.int64)}, identity="particles",
    )
    samples = BundleValue("test/samples@1", {
        "temperature": FieldValue(particles, "particle", "TestTemperature", "K", np.array([310., 320.])),
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
    assert np.array_equal(particle_field.domain.attributes["id"], [11, 12])
    assert particle_field.location == "particle"
    return SolverResult(
        artifacts={"answer": float(field.values.sum() + particle_field.values.sum())},
        observations={"pid": os.getpid()},
    )


producer = SolverImplementation(abi_version=2, run=produce)
consumer = SolverImplementation(abi_version=2, run=consume)
