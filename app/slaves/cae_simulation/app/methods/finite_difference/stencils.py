from __future__ import annotations

from typing import Any

import numpy as np

from app.methods.structured.box import Stencil, StencilTerm


def first_derivative_stencil(axis: int, spacing: float, dimensions: int) -> Stencil:
    negative = [0] * dimensions
    positive = [0] * dimensions
    negative[axis] = -1
    positive[axis] = 1
    return Stencil(
        (
            StencilTerm(tuple(negative), -0.5 / spacing),
            StencilTerm(tuple(positive), 0.5 / spacing),
        )
    )


def second_derivative_stencil(axis: int, spacing: float, dimensions: int) -> Stencil:
    negative = [0] * dimensions
    positive = [0] * dimensions
    negative[axis] = -1
    positive[axis] = 1
    scale = 1.0 / (spacing * spacing)
    return Stencil(
        (
            StencilTerm(tuple(negative), scale),
            StencilTerm((0,) * dimensions, -2.0 * scale),
            StencilTerm(tuple(positive), scale),
        )
    )


def laplacian_stencil(spacings: tuple[float, ...]) -> Stencil:
    dimensions = len(spacings)
    terms: list[StencilTerm] = []
    center = 0.0
    for axis, spacing in enumerate(spacings):
        negative = [0] * dimensions
        positive = [0] * dimensions
        negative[axis] = -1
        positive[axis] = 1
        scale = 1.0 / (spacing * spacing)
        terms.extend((StencilTerm(tuple(negative), scale), StencilTerm(tuple(positive), scale)))
        center -= 2.0 * scale
    terms.append(StencilTerm((0,) * dimensions, center))
    return Stencil(tuple(terms))


def apply_stencil(
    values: np.ndarray[Any, Any],
    stencil: Stencil,
    interior: tuple[slice, ...] | None = None,
) -> np.ndarray[Any, Any]:
    values = np.asarray(values)
    if interior is None:
        interior = tuple(
            slice(radius, size - radius if radius else size)
            for size, radius in zip(values.shape, stencil.radius, strict=True)
        )
    bounds = [part.indices(size) for part, size in zip(interior, values.shape, strict=True)]
    if any(step != 1 for _, _, step in bounds):
        raise ValueError("stencil interiors must use a unit stride")
    result = np.zeros(values[interior].shape, dtype=np.result_type(values.dtype, np.float64))
    for term in stencil.terms:
        shifted = tuple(
            slice(start + offset, stop + offset)
            for (start, stop, _), offset in zip(bounds, term.offset, strict=True)
        )
        result += term.coefficient * values[shifted]
    return result
