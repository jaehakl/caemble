"""Deterministic area-uniform sampling of surviving continuous CSG surfaces."""

import math

import numpy as np

from app.methods.geometry.analytic import SurfaceRef
from .analytic import _leaf_events
from .roots import UnresolvedIntersection
from .tracing import counter_random


class AnalyticSurfaceSampler:
    def __init__(self, solids, selectors):
        selected = {
            SurfaceRef(s["rootId"], s["sourceNodeId"], s["surfaceIndex"])
            for s in selectors
        }
        self.cells = []
        self.prior_surfaces = {}
        preceding = []
        for root_id in sorted(solids):
            solid = solids[root_id]
            for patch in solid.patches:
                if patch.reference not in selected:
                    continue
                # Identical instances in a union are one physical emitter.
                index = next(
                    i for i, leaf in enumerate(solid.leaves) if leaf is patch.leaf
                )
                duplicates = [
                    p
                    for i in solid.equivalent_leaves[index]
                    if solid.leaves[i].occurrence_id < patch.leaf.occurrence_id
                    for p in solid.leaves[i].patches
                    if p.surface_index == patch.surface_index
                    and p.reference in selected
                ]
                if duplicates:
                    continue
                self.prior_surfaces[id(patch)] = [
                    (other_solid, other)
                    for other_solid, other in preceding
                    if other.leaf is not patch.leaf
                    and np.all(other.leaf.maximum >= patch.leaf.minimum)
                    and np.all(other.leaf.minimum <= patch.leaf.maximum)
                ]
                preceding.append((solid, patch))
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
                        bounds = patch.enclosure(u, v)
                        if not solid.boundary_possible(patch, *bounds):
                            continue
                        jacobian = patch.enclosure(u, v, derivatives=True)
                        weight = jacobian * (u[1] - u[0]) * (v[1] - v[0])
                        if weight > 0:
                            self.cells.append((solid, patch, u, v, jacobian, weight))
        if not self.cells:
            raise ValueError(
                "Emitter selection has no positive-area continuous boundary"
            )
        self.cumulative = np.cumsum([cell[-1] for cell in self.cells])
        if not math.isfinite(self.cumulative[-1]):
            raise UnresolvedIntersection("Emitter area enclosure is not finite")

    def sample(self, seed, rule_index, sample_index):
        for attempt in range(100000):
            values = [
                counter_random(seed, rule_index, sample_index, 100 + i, attempt)
                for i in range(4)
            ]
            index = min(
                len(self.cells) - 1,
                int(
                    np.searchsorted(
                        self.cumulative, values[0] * self.cumulative[-1], side="right"
                    )
                ),
            )
            solid, patch, u, v, bound, _ = self.cells[index]
            uu, vv = u[0] + values[1] * (u[1] - u[0]), v[0] + values[2] * (v[1] - v[0])
            point, normal, du, dv = patch.evaluate(uu, vv)
            jacobian = np.linalg.norm(np.cross(du, dv))
            if jacobian > bound * (1 + 32 * np.finfo(float).eps):
                raise UnresolvedIntersection(
                    f"Invalid area bound for {patch.reference}"
                )
            if values[3] * bound >= jacobian:
                continue
            normal = solid.boundary_normal(patch, point, normal)
            if normal is not None:
                # Partially coincident boundaries (for example overlapping box
                # faces) belong to the first selected occurrence only. Whole-
                # leaf equivalence alone would overweight their shared area.
                duplicate = False
                for other_solid, other in self.prior_surfaces[id(patch)]:
                    rounding = (
                        32
                        * np.finfo(float).eps
                        * max(
                            np.linalg.norm(point),
                            np.linalg.norm(other.leaf.maximum - other.leaf.minimum),
                        )
                    )
                    if np.any(point < other.leaf.minimum - rounding) or np.any(
                        point > other.leaf.maximum + rounding
                    ):
                        continue
                    for event in _leaf_events(other.leaf, point, normal):
                        if event.surface_ref != other.reference:
                            continue
                        if abs(event.distance) > event.distance_error + rounding:
                            continue
                        if abs(event.distance) > rounding:
                            raise UnresolvedIntersection(
                                "Cannot distinguish coincident emitter boundaries"
                            )
                        if (
                            other_solid.boundary_normal(other, point, event.normal)
                            is not None
                        ):
                            duplicate = True
                            break
                    if duplicate:
                        break
                if not duplicate:
                    return point, normal
        raise UnresolvedIntersection(
            "Emitter selection is empty or its clipped area could not be resolved"
        )
