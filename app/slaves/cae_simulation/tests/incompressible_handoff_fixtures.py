"""Real CFD producer and a surface-only consumer for child ownership tests."""

import os
from dataclasses import replace

import numpy as np

from app.kernel.api import FieldValue, SolverImplementation, SolverResult, UnstructuredMeshValue


async def produce(invocation):
    from app.solvers.incompressible_flow.entry import run

    result = await run(invocation)
    return replace(result, observations={**result.observations, "pid": os.getpid()})


async def consume(invocation):
    assert not invocation.state and not invocation.world
    field = invocation.inputs["traction"].value
    assert isinstance(field, FieldValue) and isinstance(field.domain, UnstructuredMeshValue)
    assert field.location == "cell" and field.unit == "Pa" and field.quantity_kind == "mechanics.Traction"
    assert field.components == ("x", "y", "z") and field.domain.unit == "m"
    assert field.metadata["normalConvention"] == "outward-fluid"
    assert field.metadata["actionTarget"] == "fluid-on-solid"
    assert field.metadata["coordinateFrame"] == "world"
    assert field.metadata["pressureKind"] == "gauge"
    np.testing.assert_array_equal(field.metadata["sampleAxes"][0]["ticks"], [invocation.config["time"]])
    assert not field.values.flags.writeable and not field.domain.points.flags.writeable
    triangles = field.domain.points[field.domain.cells["tri3"]]
    areas = np.linalg.norm(np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]), axis=1) / 2
    forces = areas[:, None] * field.values[:, 0]
    moments = np.cross(triangles.mean(axis=1) - np.asarray(invocation.config["momentOrigin"]), forces)
    provenance = field.domain.metadata["boundaryProvenance"]
    assert len(provenance["offsets"]) == len(triangles) + 1
    assert provenance["offsets"][-1] == len(provenance["surfaceIndices"])
    assert len(field.domain.metadata["sourceMeshNodeIds"]) == len(field.domain.points)
    return SolverResult(artifacts={"answer": np.r_[forces.sum(axis=0), moments.sum(axis=0)]},
                        observations={"pid": os.getpid()})


producer = SolverImplementation(abi_version=3, run=produce)
consumer = SolverImplementation(abi_version=3, run=consume)
