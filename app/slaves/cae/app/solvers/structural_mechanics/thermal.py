"""Small-strain thermal eigenstrain, owned by the structural constitutive path."""

import numpy as np

from app.kernel.api.world import geometry_parts, material_model, scalar_parameter
from app.methods.coupling.assembly import transfer_assembly_element_nodal_field

from .continuum import integration_points
from .solid_elements import SolidElements


def configure_thermal_expansion(invocation, model):
    rules = [rule for rule in invocation.config["initializations"] if rule["methodId"] == "fea.thermal-expansion"]
    temperature = invocation.inputs.get("temperature")
    if not rules and temperature is None:
        return
    if not rules or temperature is None:
        raise ValueError("temperature input and fea.thermal-expansion must be used together")
    if not temperature.value.metadata.get("accepted", True):
        raise ValueError("structural thermal input must be an accepted temperature, not a coupling trial")
    model.thermal_time_history = temperature.value.metadata.get("analysis") == "transient"
    if model.assembly_domain is None:
        raise ValueError("thermal expansion requires fea.mesh and a common canonical assembly")
    parameters = invocation.config["parameters"]
    supported_elements = (all(material["model"] in ("mechanics.isotropic-elastic@1", "mechanics.orthotropic-elastic@1")
                              for material in model.elements.materials) if isinstance(model.elements, SolidElements)
                          else all(element.kind == "tet4" and element.material["model"] in
                                   ("mechanics.isotropic-elastic@1", "mechanics.orthotropic-elastic@1") for element in model.elements))
    if (parameters["analysis"] != "static" or scalar_parameter(parameters["geometricNonlinear"])
            or model.solid_formulation != "displacement" or model.contacts or model.links or model.springs
            or model.rotor is not None or model.follower_pressures
            or not supported_elements):
        raise ValueError("thermal expansion supports only static small-strain bonded elastic solids without contact or connections")
    values = transfer_assembly_element_nodal_field(
        temperature.value, model.assembly_domain, quantity_kind="thermodynamics.Temperature", unit="K")
    model.thermal_strain = np.zeros((len(model.elements), 4))
    assigned = np.zeros(len(model.elements), dtype=bool)
    for rule in rules:
        stress_free = scalar_parameter(rule["parameters"]["stressFreeTemperature"])
        for target in rule["target"]:
            if target not in model.cell_regions:
                raise ValueError("thermal expansion regions must be selected by fea.body")
            source, _, group = target.split(".", 2)
            parts = {part["id"]: part for part in geometry_parts(invocation.world[source], group)}
            coefficients = {}
            for root, part in parts.items():
                selected = material_model(invocation.world, part, "thermalExpansionDomain", "expansion", source)
                if selected is None or selected["model"] != "mechanics.isotropic-thermal-expansion@1":
                    raise ValueError("thermal expansion requires an explicitly selected isotropic thermal expansion model")
                coefficients[root] = scalar_parameter(selected["parameters"]["alpha"])
            indices = model.cell_regions[target]
            if np.any(assigned[indices]):
                raise ValueError("thermal expansion regions must not overlap")
            assigned[indices] = True
            if isinstance(model.elements, SolidElements):
                alpha = np.asarray([coefficients.get(root, 0.) for root in model.elements.root_ids])
                for start in range(0, len(indices), 65536):
                    selected = indices[start:start + 65536]
                    model.thermal_strain[selected] = alpha[model.elements.material_indices[selected], None] * (values[selected] - stress_free)
            else:
                for index in indices:
                    element = model.elements[index]
                    model.thermal_strain[index] = coefficients[element.root_id] * (values[index] - stress_free)


def thermal_element_response(points, displacement, elasticity, nodal_strain):
    """Consistent internal force, integration-point stress and elastic energy."""
    force = np.zeros(12)
    stresses, energy = [], 0.0
    for N, B, weight, _ in integration_points("tet4", points):
        strain = B @ np.asarray(displacement).ravel()
        strain[:3] -= N @ nodal_strain
        stress = elasticity @ strain
        force += B.T @ stress * weight
        stresses.append(stress)
        energy += .5 * strain @ stress * weight
    return force, np.asarray(stresses), float(energy)


def prepare_thermal_force(model, prepared):
    if model.thermal_strain is None or prepared.thermal_batch is not None:
        return
    model.thermal_force = np.zeros(model.size)
    for index, (element, data) in enumerate(zip(model.elements, prepared.element_data, strict=True)):
        internal, _, _ = thermal_element_response(model.points[element.nodes], np.zeros(12),
                                                  element.material["C"], model.thermal_strain[index])
        np.add.at(model.thermal_force, data["dofs"], -internal)


def thermal_stress_at(model, solution, index, barycentric):
    """P1 temperature gives affine stress, even though displacement strain is constant."""
    average = np.asarray(solution.stresses[index]).mean(axis=0)
    eigenstrain = model.thermal_strain[index]
    change = np.asarray(barycentric) @ eigenstrain - eigenstrain.mean()
    return average - change[..., None] * model.elements[index].material["C"][:, :3].sum(axis=1)
