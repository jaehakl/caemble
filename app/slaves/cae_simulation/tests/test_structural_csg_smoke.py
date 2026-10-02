"""Explicit product entry checks, excluded from low-cost collection."""
from tests.structural_fixture import solid_invocation
from dataclasses import replace
from types import SimpleNamespace
import pytest
from app.solvers.structural_mechanics.entry import run
from tests.structural_csg_fixtures import UnexpectedGeometry


@pytest.mark.parametrize("analysis", ["modal", "harmonic", "transient"])
@pytest.mark.asyncio
async def test_resultant_transfer_rejects_unsupported_analysis_before_meshing(analysis):
    invocation = solid_invocation()
    invocation.config["parameters"]["analysis"] = analysis
    invocation.config["boundaryConditions"].append({
        "methodId": "fea.resultant-transfer", "target": ["experiment.surface.body-right"],
        "parameters": {"sourceRegion": "experiment.surface.body-right", "referencePoint": [0., 0., 0.]},
    })

    invocation = replace(invocation, geometry=UnexpectedGeometry())
    with pytest.raises(ValueError, match="only for static and buckling"):
        await run(invocation)


@pytest.mark.parametrize("port", ["loads", "previousMotion", "control"])
@pytest.mark.asyncio
async def test_transient_coupling_ports_reject_other_analyses_before_meshing(port):
    invocation = solid_invocation()
    value = [SimpleNamespace()] if port == "loads" else SimpleNamespace()
    invocation = replace(invocation, inputs={port: value}, geometry=UnexpectedGeometry())
    with pytest.raises(ValueError, match="only for transient analysis"):
        await run(invocation)


@pytest.mark.asyncio
async def test_control_requires_rotor_before_meshing():
    invocation = solid_invocation()
    invocation.config["parameters"]["analysis"] = "transient"
    invocation = replace(invocation, inputs={"control": SimpleNamespace()}, geometry=UnexpectedGeometry())
    with pytest.raises(ValueError, match="requires a fea.rotor"):
        await run(invocation)


@pytest.mark.parametrize("port", ["sourceLoads", "sourceMotion"])
@pytest.mark.asyncio
async def test_source_coupling_ports_require_resultant_transfer_before_meshing(port):
    invocation = solid_invocation()
    value = [SimpleNamespace()] if port == "sourceLoads" else SimpleNamespace()
    invocation = replace(invocation, inputs={port: value}, geometry=UnexpectedGeometry())
    with pytest.raises(ValueError, match="require fea.resultant-transfer"):
        await run(invocation)
