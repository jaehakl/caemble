"""Tight bounds of the final continuous solid, separate from traversal bounds."""

import heapq
import itertools
import math

import numpy as np
from .interval import Interval


def solid_bounds(solid):
    if len(solid.leaves) == 1:
        leaf = solid.leaves[0]
        p, a = leaf.parameters, leaf.matrix
        if leaf.kind == "box":
            radius = np.abs(a[:3, :3]) @ (np.asarray(p["size"]) / 2)
            return a[:3, 3] - radius, a[:3, 3] + radius
        if leaf.kind in {"sphere", "ellipsoid"}:
            axial = p["radius"] if leaf.kind == "sphere" else p["axialRadius"]
            radial = (
                axial
                if leaf.kind == "sphere"
                else math.sqrt(
                    (axial - p["focalDistance"]) * (axial + p["focalDistance"])
                )
            )
            radius = np.linalg.norm(
                a[:3, :3] * np.array([radial, radial, axial]), axis=1
            )
            return a[:3, 3] - radius, a[:3, 3] + radius
    scale = max(np.linalg.norm(solid.maximum - solid.minimum), np.finfo(float).tiny)
    tolerance = 1e-9 * scale + 64 * np.finfo(float).eps * max(
        np.max(np.abs(solid.minimum)), np.max(np.abs(solid.maximum))
    )
    result = np.zeros((2, 3))
    for axis in range(3):
        for side, sign in enumerate((-1, 1)):
            pending, sequence, best = [], itertools.count(), -math.inf

            def offer(patch, u, v):
                nonlocal best
                low, high = patch.enclosure(u, v)
                low, high = (
                    np.maximum(low, solid.minimum),
                    np.minimum(high, solid.maximum),
                )
                if np.any(low > high):
                    return
                if not solid.boundary_possible(patch, low, high):
                    return
                bound = high[axis] if sign == 1 else -low[axis]
                du, dv = patch.derivative_bounds(Interval(*u), Interval(*v))
                center = patch.expression(sum(u) / 2, sum(v) / 2)
                affine = patch.leaf.matrix
                center_value = float(affine[axis, :3] @ center + affine[axis, 3])
                variation = (
                    du[axis].magnitude * (u[1] - u[0]) / 2
                    + dv[axis].magnitude * (v[1] - v[0]) / 2
                )
                rounding = (
                    64 * np.finfo(float).eps * (abs(center_value) + variation + scale)
                )
                bound = min(bound, sign * center_value + variation + rounding)
                if bound <= best + tolerance:
                    return
                for uu, vv in (
                    (sum(u) / 2, sum(v) / 2),
                    (u[0], v[0]),
                    (u[0], v[1]),
                    (u[1], v[0]),
                    (u[1], v[1]),
                ):
                    point, normal, _, _ = patch.evaluate(uu, vv)
                    if solid.boundary_normal(patch, point, normal) is not None:
                        best = max(best, sign * point[axis])
                if bound > best + tolerance:
                    heapq.heappush(pending, (-bound, next(sequence), patch, u, v))

            for patch in solid.patches:
                for i in range(4):
                    for j in range(8):
                        u = tuple(
                            patch.u_range[0]
                            + (patch.u_range[1] - patch.u_range[0]) * k / 4
                            for k in (i, i + 1)
                        )
                        v = tuple(
                            patch.v_range[0]
                            + (patch.v_range[1] - patch.v_range[0]) * k / 8
                            for k in (j, j + 1)
                        )
                        offer(patch, u, v)
            visits = 0
            while pending:
                negative_bound, _, patch, u, v = heapq.heappop(pending)
                if -negative_bound <= best + tolerance:
                    break
                visits += 1
                if visits > 200000:
                    raise RuntimeError(
                        f"Unresolved continuous bounds for {solid.root_id}, axis {axis}, side {sign}"
                    )
                du, dv = patch.derivative_bounds(Interval(*u), Interval(*v))
                if du[axis].magnitude * (u[1] - u[0]) >= dv[axis].magnitude * (
                    v[1] - v[0]
                ):
                    mid = sum(u) / 2
                    offer(patch, (u[0], mid), v)
                    offer(patch, (mid, u[1]), v)
                else:
                    mid = sum(v) / 2
                    offer(patch, u, (v[0], mid))
                    offer(patch, u, (mid, v[1]))
            if not math.isfinite(best):
                raise ValueError(
                    f"Point source {solid.root_id} has no nonempty continuous solid"
                )
            result[side, axis] = sign * best
    return result[0], result[1]
