"""Native display fields; spectral results never use transient initial values."""

import numpy as np

from app.kernel.api import BundleValue, FieldValue

from ..continuum import integration_points
from ..domain import parameter
from ..model import HarmonicSolution
from .fields import _physical_domain, _tet_stress
from .history import history_members


def build_visualizations(config, descriptor, model, solution):
    domain, cell_order = _physical_domain(model)
    count = len(domain.points)
    visuals = {}
    if isinstance(solution, HarmonicSolution):
        frequencies = solution.frequencies
        displacement = np.moveaxis(solution.complex_displacement[:, :count, :3], 0, 1)
        stresses = []
        for index in cell_order:
            element = model.elements[index]
            if element.kind != "tet4":
                raise ValueError("harmonic native visualization requires tet4 physical elements")
            B = integration_points("tet4", model.points[element.nodes])[0][1]
            strains = solution.complex_displacement[:, element.nodes, :3].reshape(len(frequencies), -1) @ B.T
            stresses.append(strains @ element.material["C"].T)
        stress = np.asarray(stresses)
        metadata = {"sampleAxes": [{"axis": 1, "name": "frequency", "unit": "Hz", "ticks": frequencies}],
                    "timeConvention": "exp(+i*omega*t)", "amplitude": "peak", "configuration": "reference"}
        for name, values, location, components in (
            ("harmonicDisplacement", displacement, "node", ("x", "y", "z")),
            ("harmonicStress", stress, "cell", ("xx", "yy", "zz", "xy", "yz", "xz")),
        ):
            definition = descriptor.get("visualizations", {}).get(name)
            if definition is None:
                continue
            data = definition["data"]["members"]["field"]
            field = FieldValue(domain, location, data["quantityKind"], data["unit"], values.astype(np.complex64), data.get("basis"), components, metadata)
            visuals[name] = BundleValue(definition["artifactType"], {
                "field": field, "frequencies": {"value": frequencies, "axes": [{"ticks": frequencies}]},
            }, {"timeConvention": "exp(+i*omega*t)", "amplitude": "peak", "configuration": "reference"})
        return visuals

    stresses = np.asarray([_tet_stress(model, solution, index) for index in cell_order]).reshape(-1, 3, 3)
    compact = stresses[:, (0, 1, 2, 0, 1, 0), (0, 1, 2, 1, 2, 2)]
    for name, definition in descriptor.get("visualizations", {}).items():
        data = definition["data"]
        if name == "displacement":
            visuals[name] = FieldValue(domain, "node", data["quantityKind"], data["unit"], solution.displacement[:count, :3], data.get("basis"), ("x", "y", "z"))
        elif name == "stress":
            visuals[name] = FieldValue(domain, "cell", data["quantityKind"], data["unit"], compact, data.get("basis"), ("xx", "yy", "zz", "xy", "yz", "xz"))
        elif name == "displacementHistory" and parameter(config["parameters"]["analysis"]) == "transient":
            histories = history_members(model, solution, model.node_ids[:count])
            data = data["members"]["field"]
            field = FieldValue(domain, "node", data["quantityKind"], data["unit"], histories["displacement"][-1], data.get("basis"), ("x", "y", "z"))
            visuals[name] = BundleValue(definition["artifactType"], {
                "field": field,
                "times": {"value": histories["times"], "axes": [{"ticks": histories["times"]}]},
                "values": {"value": histories["displacement"], "axes": [{"ticks": histories["times"]}, {"ticks": model.node_ids[:count]}, {"implicitOrdinal": True}]},
            })
    return visuals
