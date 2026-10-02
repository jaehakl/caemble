"""Electrical constitutive laws evaluated on the native P1 temperature."""

import numpy as np

from app.kernel.api.world import scalar_parameter
from app.methods.coupling.assembly import transfer_assembly_element_nodal_field
from app.methods.finite_element.scalar import TET4_QUADRATURE


def evaluate_conductivity(mesh, models, temperature=None):
    temperatures = None if temperature is None else transfer_assembly_element_nodal_field(
        temperature, mesh.field_domain, quantity_kind="thermodynamics.Temperature", unit="K")
    conductivity = np.empty((len(mesh.elements.cells), 3, 3))
    for root, model in models.items():
        selected = np.flatnonzero(np.asarray(mesh.field_domain.metadata["cellRegions"]) == mesh.assembly.region_ids.index(root))
        parameters = model["parameters"]
        key = "sigma" if model["model"] == "electrical.ohmic-conduction@1" else "rhoRef"
        tensor = np.asarray(parameters[key]["value"], dtype=float).reshape(3, 3)
        coefficient = float(np.trace(tensor) / 3)
        if coefficient <= 0 or not np.isfinite(tensor).all() or not np.allclose(tensor, np.eye(3) * coefficient, rtol=1e-10, atol=0):
            raise ValueError("DC requires positive isotropic conductivity or reference resistivity")
        if model["model"] == "electrical.ohmic-conduction@1":
            conductivity[selected] = tensor
            continue
        if model["model"] != "electrical.linear-resistivity@1":
            raise ValueError("unsupported electrical conduction model")
        if temperatures is None:
            raise ValueError("temperature-dependent resistivity requires a native temperature input")
        lower, upper = (scalar_parameter(parameters[name]) for name in ("minimumTemperature", "maximumTemperature"))
        reference, alpha = (scalar_parameter(parameters[name]) for name in ("referenceTemperature", "alphaR"))
        nodal = temperatures[selected]
        if lower < 0 or not lower <= reference <= upper or lower == upper:
            raise ValueError("resistivity temperature range must contain its reference temperature")
        if np.any(nodal < lower) or np.any(nodal > upper):
            raise ValueError("temperature lies outside the resistivity model's valid temperature range")
        # Check extrema as well as quadrature; P1 temperatures lie in the nodal range.
        if np.any(1 + alpha * (nodal - reference) <= 0):
            raise ValueError("temperature-dependent resistivity must remain positive")
        quadrature = nodal @ TET4_QUADRATURE.T
        average = np.mean(1 / (coefficient * (1 + alpha * (quadrature - reference))), axis=1)
        conductivity[selected] = average[:, None, None] * np.eye(3)
    return conductivity
