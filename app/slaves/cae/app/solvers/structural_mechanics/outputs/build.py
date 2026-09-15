"""Compose recording, native interface exports and automatic display values."""

import numpy as np

from app.kernel.api import BundleValue, FieldValue

from ..interfaces.harmonic_surface import harmonic_surface_motion
from ..interfaces.motion import interface_members, interface_metadata
from ..interfaces.transient_surface import transient_surface_motion
from .box_grid import build_box_outputs
from .visualizations import build_visualizations
from .fields import _physical_domain, finite_deformation_fields


def build_outputs(config, descriptor, model, solution, motion=None, surface_samples=None):
    artifacts = build_box_outputs(config, descriptor, model, solution)
    exports = {}
    finite_fields = None
    for output in config.get("exports", ()):
        method = output["methodId"]
        if method in ("fea.deformation-gradient", "fea.first-piola-stress"):
            if finite_fields is None:
                finite_fields = finite_deformation_fields(model, solution)
            name = "deformationGradient" if method == "fea.deformation-gradient" else "firstPiolaStress"
            definition = next(item for item in descriptor["methods"]["exports"] if item["methodId"] == method)["data"]
            domain, order = _physical_domain(model)
            value = FieldValue(domain, "cell", definition["quantityKind"], definition["unit"], finite_fields[name][order], np.eye(3),
                               metadata={"configuration": "reference", "rowConfiguration": "current", "columnConfiguration": "reference"})
        elif method == "fea.interface":
            value = BundleValue("caemble.mechanics/interface@1", interface_members(model), interface_metadata(model))
        elif method == "fea.motion":
            if motion is None:
                raise ValueError("motion export requires transient analysis")
            value = motion
        elif method == "fea.harmonic-surface-motion":
            value = harmonic_surface_motion(model, solution, output["target"])
        elif method == "fea.transient-surface-motion":
            if surface_samples is None:
                raise ValueError("actual surface motion export requires transient surface samples")
            value = transient_surface_motion(surface_samples, output["key"])
        else:
            raise ValueError(f"unsupported structural native export {method!r}")
        exports[output["key"]] = value
    return artifacts, exports, build_visualizations(config, descriptor, model, solution)
