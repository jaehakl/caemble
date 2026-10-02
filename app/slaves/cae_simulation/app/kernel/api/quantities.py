"""Shared physical-array validation against a frozen Catalog definition."""

from collections.abc import Mapping
from itertools import product

import numpy as np

from .units import convert_ucum_value
from .values import FieldValue, QuantityArrayValue


def validate_quantity_array(value: QuantityArrayValue | FieldValue, definition: Mapping, path: str) -> int:
    """Validate physical meaning separately from explicit component storage axes."""
    if definition.get("name") != value.quantity_kind:
        raise ValueError(f"{path}.quantity_kind is not registered: {value.quantity_kind}")
    units = definition.get("applicableUnits", ())
    try:
        if not units:
            raise ValueError("QuantityKind has no physical units")
        convert_ucum_value(1, value.unit, units[0])
    except Exception as error:
        raise ValueError(f"{path}.unit {value.unit!r} is incompatible with {value.quantity_kind}") from error
    array = value.values
    if not isinstance(array, np.ndarray) or not np.issubdtype(array.dtype, np.number):
        raise ValueError(f"{path}.values must be a numeric ndarray")
    if not np.all(np.isfinite(array)):
        raise ValueError(f"{path}.values must contain finite numbers")
    order = definition["tensorOrder"]
    basis = None if value.basis is None else np.asarray(value.basis)
    if basis is not None and (basis.shape != (3, 3) or not np.issubdtype(basis.dtype, np.number)
                              or np.iscomplexobj(basis) or not np.all(np.isfinite(basis))
                              or not np.allclose(basis @ basis.T, np.eye(3), atol=1e-10)):
        raise ValueError(f"{path}.basis must be an orthonormal Cartesian 3 by 3 basis")
    if value.components is not None:
        if array.ndim == 0 or array.shape[-1] != len(value.components):
            raise ValueError(f"{path}.values trailing dimension must match components")
        if order:
            labels = {"".join(component) for component in product("xyz", repeat=order)}
            if not set(value.components) <= labels:
                raise ValueError(f"{path}.components do not match QuantityKind tensor order {order}")
            symmetric = order == 2 and definition.get("tensorSymmetry") == "symmetric"
            allowed_counts = {9, 6} if symmetric else {3 ** order}
            if len(value.components) not in allowed_counts:
                raise ValueError(f"{path}.components have an invalid component count")
            if order == 2 and len(value.components) == 6:
                selected = set(value.components)
                if not {"xx", "yy", "zz"} <= selected or any(
                    len(selected & pair) != 1 for pair in ({"xy", "yx"}, {"yz", "zy"}, {"xz", "zx"})
                ):
                    raise ValueError(f"{path}.components must identify the six independent symmetric tensor entries")
        # Scalar QuantityKinds may label several scalar entries on one explicit
        # axis (for example, the existing six Pressure-valued stress channels).
        # This storage axis does not change the QuantityKind's physical order.
        return 1
    if order and (array.ndim < order or array.shape[-order:] != (3,) * order):
        raise ValueError(f"{path}.values must have {(3,) * order} tensor components")
    return order


def validate_field_domain(value: FieldValue, component_rank: int) -> None:
    """Validate entity counts independently from explicitly located sample axes."""
    from .values import ParticleSetValue, RaySetValue, StructuredGridValue, UnstructuredMeshValue

    shape = list(value.values.shape[:-component_rank] if component_rank else value.values.shape)
    samples = value.metadata.get("sampleAxes", ())
    selected = []
    for default_axis, sample in enumerate(samples):
        index = sample.get("axis", default_axis)
        ticks = np.asarray(sample.get("ticks"))
        if (type(index) is not int or index < 0 or index >= len(shape) or index in selected
                or ticks.ndim != 1 or len(ticks) != shape[index]):
            raise ValueError("field sampleAxes must match explicit sample dimensions")
        selected.append(index)
    shape = tuple(size for index, size in enumerate(shape) if index not in selected)
    domain = value.domain
    if isinstance(domain, StructuredGridValue):
        expected = domain.shape
    elif isinstance(domain, ParticleSetValue):
        expected = (len(domain.positions),)
    elif isinstance(domain, RaySetValue):
        expected = (len(domain.origins),)
    elif isinstance(domain, UnstructuredMeshValue):
        if value.location == "node":
            expected = (len(domain.points),)
        elif value.location == "cell":
            expected = (sum(len(block) for block in domain.cells.values()) if isinstance(domain.cells, Mapping)
                        else len(domain.cells),)
        else:
            return  # Edge/face topology is owned by the mesh method.
    else:
        raise ValueError("field domain must be a canonical domain value")
    if shape != expected:
        raise ValueError(f"field values entity dimensions must match domain {expected}, got {shape}")
