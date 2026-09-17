"""Ray events on continuous solids, including final CSG boundary selection."""

from __future__ import annotations

import math
from dataclasses import dataclass, replace

import numpy as np

from app.methods.geometry.analytic import AnalyticSolid, SurfaceRef
from app.methods.geometry.continuous import sag, sag_squared
from app.methods.geometry.curved import curved_radius
from app.methods.geometry.fiber import evaluate_fiber
from app.methods.geometry.interval import Dual, Interval, atan2, sqrt
from .roots import UnresolvedIntersection, isolate_roots, quadratic, ray_box


@dataclass(frozen=True, slots=True)
class RayMetadata:
    root_id: str
    material_name: str | None


@dataclass(frozen=True, slots=True)
class AnalyticHit:
    distance: float
    position: np.ndarray
    normal: np.ndarray
    surface_ref: SurfaceRef
    occurrence_id: tuple[int, ...]
    surface_coordinates: tuple[float, float]
    crossing_kind: str
    distance_error: float
    position_error: np.ndarray
    metadata: RayMetadata


@dataclass(frozen=True, slots=True)
class IntersectionResult:
    status: str
    events: tuple[AnalyticHit, ...] = ()
    diagnostic: str | None = None


def _leaf_events(leaf, origin, direction):
    interval = ray_box(origin, direction, leaf.minimum, leaf.maximum)
    if interval is None:
        return []
    o = leaf.inverse[:3, :3] @ origin + leaf.inverse[:3, 3]
    d = leaf.inverse[:3, :3] @ direction
    p, kind = leaf.parameters, leaf.kind
    local_scale = max(
        np.linalg.norm(o),
        np.linalg.norm(d) * (interval[1] - interval[0]),
        np.finfo(float).tiny,
    )
    time_error = (
        128
        * np.finfo(float).eps
        * max(abs(interval[0]), abs(interval[1]), local_scale / np.linalg.norm(d))
    )
    spatial_error = time_error * np.linalg.norm(d)
    events = []

    def append(t, normal, surface, coordinates=(0.0, 0.0), error=0.0):
        if (
            not math.isfinite(t)
            or t < interval[0] - time_error
            or t > interval[1] + time_error
        ):
            return
        normal = leaf.inverse[:3, :3].T @ np.asarray(normal, dtype=float)
        length = np.linalg.norm(normal)
        if length == 0 or not math.isfinite(length):
            raise UnresolvedIntersection(
                f"{leaf.root_id}/{leaf.occurrence_id}: nonregular normal at t={t}"
            )
        normal /= length
        error = max(time_error, error)
        point = origin + t * direction
        rounding = (
            16 * np.finfo(float).eps * (np.abs(origin) + abs(t) * np.abs(direction))
        )
        events.append(
            AnalyticHit(
                float(t),
                point,
                normal,
                SurfaceRef(leaf.root_id, leaf.node["nodeId"], surface),
                leaf.occurrence_id,
                tuple(map(float, coordinates)),
                "touch",
                error,
                np.abs(direction) * error + rounding,
                RayMetadata(leaf.root_id, None),
            )
        )

    def disk(z, radius, surface):
        if d[2] == 0:
            return
        t = (z - o[2]) / d[2]
        point = o + t * d
        theta = math.atan2(point[1], point[0])
        r = radius(theta) if callable(radius) else radius
        if np.linalg.norm(point[:2]) <= r + spatial_error:
            append(
                t,
                [0, 0, -1 if surface == 0 else 1],
                surface,
                (np.linalg.norm(point[:2]) / r if r else 0, theta),
            )

    if kind == "box":
        half = np.asarray(p["size"]) / 2
        for axis in range(3):
            if d[axis] == 0:
                continue
            for side in (-1, 1):
                t = (side * half[axis] - o[axis]) / d[axis]
                point = o + t * d
                if np.all(np.abs(point) <= half + spatial_error):
                    normal = np.zeros(3)
                    normal[axis] = side
                    axes = [i for i in range(3) if i != axis]
                    append(
                        t,
                        normal,
                        2 * axis + int(side > 0),
                        tuple(point[i] / (2 * half[i]) + 0.5 for i in axes),
                    )
    elif kind in {"sphere", "ellipsoid"}:
        a = p["radius"] if kind == "sphere" else p["axialRadius"]
        b2 = (
            a * a
            if kind == "sphere"
            else (a - p["focalDistance"]) * (a + p["focalDistance"])
        )
        weights = np.array([1 / b2, 1 / b2, 1 / a**2])
        for t in quadratic(
            np.dot(d * weights, d),
            2 * np.dot(o * weights, d),
            np.dot(o * weights, o) - 1,
        ):
            point = o + t * d
            append(
                t,
                point * weights,
                0,
                (
                    math.acos(np.clip(-point[2] / a, -1, 1)) / math.pi,
                    math.atan2(point[1], point[0]),
                ),
            )
    elif kind == "cylinder":
        h, r0, r1 = p["height"], p["radius"], p["radius_2"]
        slope, middle = (r1 - r0) / h, (r0 + r1) / 2
        ro, rd = middle + slope * o[2], slope * d[2]
        for t in quadratic(
            np.dot(d[:2], d[:2]) - rd**2,
            2 * (np.dot(o[:2], d[:2]) - ro * rd),
            np.dot(o[:2], o[:2]) - ro**2,
        ):
            x, y, z = o + t * d
            if abs(z) <= h / 2 + spatial_error:
                append(
                    t,
                    [x, y, -slope * (middle + slope * z)],
                    1,
                    (z / h + 0.5, math.atan2(y, x)),
                )
        disk(-h / 2, r0, 0)
        disk(h / 2, r1, 2)
    elif kind in {"paraboloid", "hyperboloid"}:
        if kind == "paraboloid":
            f = p["focalLength"]
            roots = quadratic(
                np.dot(d[:2], d[:2]),
                2 * np.dot(o[:2], d[:2]) - 4 * f * d[2],
                np.dot(o[:2], o[:2]) - 4 * f * o[2],
            )
            top = p["radius"] ** 2 / (4 * f)
        else:
            a, f = p["axialRadius"], p["focalDistance"]
            b2 = (f - a) * (f + a)
            weights = np.array([1 / b2, 1 / b2, -1 / a**2])
            roots = quadratic(
                np.dot(d * weights, d),
                2 * np.dot(o * weights, d),
                np.dot(o * weights, o) + 1,
            )
            top = a * math.sqrt(1 + p["radius"] ** 2 / b2)
        for t in roots:
            x, y, z = o + t * d
            r = math.hypot(x, y)
            if (
                z >= -spatial_error
                and z <= top + spatial_error
                and r <= p["radius"] + spatial_error
            ):
                normal = (
                    [x / (2 * f), y / (2 * f), -1]
                    if kind == "paraboloid"
                    else [x / b2, y / b2, -z / a**2]
                )
                append(t, normal, 1, (r / p["radius"], math.atan2(y, x)))
        disk(top, p["radius"], 2)
    elif kind == "asphericCylinder":
        radius, thickness = p["radius"], p["centerThickness"]
        for surface, face, sign in ((0, p["bottom"], -1), (2, p["top"], 1)):

            def residual(t):
                x, y, z = [o[i] + t * d[i] for i in range(3)]
                # Outside aperture the conic need not be real. Search only the
                # ray interval through the aperture cylinder below.
                squared = x**2 + y**2
                if isinstance(squared, Dual):
                    squared = Dual(
                        Interval(
                            max(0, squared.value.lo), min(radius**2, squared.value.hi)
                        ),
                        squared.derivative,
                    )
                return z - sign * thickness / 2 - sag_squared(face, squared)

            radial_roots = quadratic(
                np.dot(d[:2], d[:2]),
                2 * np.dot(o[:2], d[:2]),
                np.dot(o[:2], o[:2]) - radius**2,
            )
            search = interval
            if len(radial_roots) == 2:
                search = (
                    max(interval[0], radial_roots[0]),
                    min(interval[1], radial_roots[1]),
                )
            elif np.dot(d[:2], d[:2]) != 0:
                if not radial_roots:
                    continue
                search = radial_roots[0], radial_roots[0]
            elif np.dot(d[:2], d[:2]) == 0 and np.dot(o[:2], o[:2]) > radius**2:
                continue
            if search[0] > search[1]:
                continue
            # Limit x/y interval dependency at the aperture using a radial
            # expression bounded to the primitive's existing valid domain.
            for root in isolate_roots(
                residual,
                *search,
                label=f"{leaf.root_id}/{surface}",
                residual_scale=local_scale,
            ):
                x, y, z = o + root.value * d
                r = math.hypot(x, y)
                if r <= radius + spatial_error:
                    derivative = float(sag(face, r)[1])
                    normal = (
                        [-sign * derivative * x / r, -sign * derivative * y / r, sign]
                        if r
                        else [0, 0, sign]
                    )
                    append(
                        root.value,
                        normal,
                        surface,
                        (r / radius, math.atan2(y, x)),
                        root.error,
                    )
        for t in quadratic(
            np.dot(d[:2], d[:2]),
            2 * np.dot(o[:2], d[:2]),
            np.dot(o[:2], o[:2]) - radius**2,
        ):
            x, y, z = o + t * d
            low, high = (
                -thickness / 2 + sag(p["bottom"], radius)[0],
                thickness / 2 + sag(p["top"], radius)[0],
            )
            if low - spatial_error <= z <= high + spatial_error:
                append(t, [x, y, 0], 1, ((z - low) / (high - low), math.atan2(y, x)))
    elif kind == "curvedEdgeCylinder":
        h = p["height"]
        search = ray_box(
            o, d, [-math.inf, -math.inf, -h / 2], [math.inf, math.inf, h / 2], *interval
        )
        if search is not None:

            def residual(t):
                x, y, z = [o[i] + t * d[i] for i in range(3)]
                if isinstance(t, Dual):
                    mid = (t.value.lo + t.value.hi) / 2
                    midpoint = o + mid * d
                    angle = math.atan2(midpoint[1], midpoint[0])
                    # Rotate the atan2 branch cut away from this candidate.
                    theta = angle + atan2(
                        y * math.cos(angle) - x * math.sin(angle),
                        x * math.cos(angle) + y * math.sin(angle),
                    )
                else:
                    theta = atan2(y, x)
                return sqrt(x**2 + y**2) - curved_radius(p, z, theta)[0]

            for root in isolate_roots(
                residual,
                *search,
                label=f"{leaf.root_id}/curved-side",
                residual_scale=local_scale,
            ):
                x, y, z = o + root.value * d
                theta = math.atan2(y, x)
                radius, rz, rt = curved_radius(p, z, theta)
                normal = [
                    math.cos(theta) + rt / radius * math.sin(theta),
                    math.sin(theta) - rt / radius * math.cos(theta),
                    -rz,
                ]
                append(root.value, normal, 1, (z / h + 0.5, theta), root.error)
        disk(-h / 2, lambda theta: curved_radius(p, -h / 2, theta)[0], 0)
        disk(h / 2, lambda theta: curved_radius(p, h / 2, theta)[0], 2)
    elif kind == "fiber":
        for span in leaf.spans:
            frame = span.frame
            relative = o - frame["center"]
            if span.bend_radius == 0:
                so, sd = np.dot(relative, frame["tangent"]), np.dot(d, frame["tangent"])
                qo, qd = relative - so * frame["tangent"], d - sd * frame["tangent"]
                ro, rd = frame["radius"] + span.slope * so, span.slope * sd
                roots = [
                    (t, time_error)
                    for t in quadratic(
                        np.dot(qd, qd) - rd**2,
                        2 * (np.dot(qo, qd) - ro * rd),
                        np.dot(qo, qo) - ro**2,
                    )
                ]
            else:
                inward = np.cross(span.axis, frame["tangent"])
                center = frame["center"] + span.bend_radius * inward
                relative = o - center
                xo, xd = -np.dot(relative, inward), -np.dot(d, inward)
                yo, yd = np.dot(relative, frame["tangent"]), np.dot(d, frame["tangent"])
                zo, zd = np.dot(relative, span.axis), np.dot(d, span.axis)

                def residual(t):
                    x, y, z = xo + t * xd, yo + t * yd, zo + t * zd
                    radius = (
                        frame["radius"]
                        if span.slope == 0
                        else frame["radius"]
                        + span.slope * span.bend_radius * atan2(y, x)
                    )
                    return (
                        (sqrt(x**2 + y**2) - span.bend_radius) ** 2 + z**2 - radius**2
                    )

                patch = next(patch for patch in leaf.patches if patch.span is span)
                bounds = patch.enclosure()
                search = ray_box(origin, direction, *bounds)
                roots = (
                    []
                    if search is None
                    else [
                        (r.value, r.error)
                        for r in isolate_roots(
                            residual,
                            *search,
                            label=f"{leaf.root_id}/fiber/{span.start}:{span.end}",
                            residual_scale=local_scale**2,
                        )
                    ]
                )
            for t, error in roots:
                point = o + t * d
                s, center, radius = span.coordinates(point)
                if span.start - spatial_error <= s <= span.end + spatial_error:
                    s = min(max(s, span.start), span.end)
                    frame_at_hit = evaluate_fiber(leaf.node, s)
                    radial = point - center
                    theta = math.atan2(
                        np.dot(radial, frame_at_hit["binormal"]),
                        np.dot(radial, frame_at_hit["normal"]),
                    )
                    normal = evaluate_fiber(leaf.node, s, theta)["outward"]
                    append(t, normal, 1, (s, theta), error)
        for s, surface, sign in (
            (0, 0, -1),
            (leaf.node["radiusProfile"][-1]["s"], 2, 1),
        ):
            frame = evaluate_fiber(leaf.node, s)
            denominator = np.dot(d, frame["tangent"])
            if denominator == 0:
                continue
            t = np.dot(frame["center"] - o, frame["tangent"]) / denominator
            radial = o + t * d - frame["center"]
            if np.linalg.norm(radial) <= frame["radius"] + spatial_error:
                append(
                    t,
                    sign * frame["tangent"],
                    surface,
                    (
                        np.linalg.norm(radial) / frame["radius"],
                        math.atan2(
                            np.dot(radial, frame["binormal"]),
                            np.dot(radial, frame["normal"]),
                        ),
                    ),
                )
    return events


def solid_events(solid, origin, direction):
    candidates = [
        (event, i)
        for i, leaf in enumerate(solid.leaves)
        for event in _leaf_events(leaf, origin, direction)
    ]
    candidates.sort(
        key=lambda item: (item[0].distance, item[0].surface_ref, item[0].occurrence_id)
    )
    groups = []
    for event, index in candidates:
        if (
            groups
            and abs(event.distance - groups[-1][0][0].distance)
            <= event.distance_error + groups[-1][0][0].distance_error
        ):
            other = groups[-1][0][0]
            if (
                event.distance != other.distance
                and event.surface_ref != other.surface_ref
                and abs(np.dot(event.normal, other.normal))
                > 1 - 32 * np.finfo(float).eps
            ):
                raise UnresolvedIntersection(
                    f"{solid.root_id}: unresolved separation of {other.surface_ref} and {event.surface_ref} near t={event.distance}"
                )
            groups[-1].append((event, index))
        else:
            groups.append([(event, index)])
    result = []
    for ordinal, group in enumerate(groups):
        t = group[0][0].distance
        before = (
            (groups[ordinal - 1][0][0].distance + t) / 2
            if ordinal
            else t - max(1, abs(t))
        )
        after = (
            (groups[ordinal + 1][0][0].distance + t) / 2
            if ordinal + 1 < len(groups)
            else t + max(1, abs(t))
        )
        previous = [
            leaf.contains(origin + before * direction, strict=True)
            for leaf in solid.leaves
        ]
        following = [
            leaf.contains(origin + after * direction, strict=True)
            for leaf in solid.leaves
        ]
        was_inside, is_inside = (
            solid.expression.evaluate(previous),
            solid.expression.evaluate(following),
        )
        valid = []
        for event, index in group:
            if was_inside != is_inside:
                changed = previous.copy()
                changed[index] = following[index]
                reverse = following.copy()
                reverse[index] = previous[index]
                if (
                    solid.expression.evaluate(changed) == was_inside
                    and solid.expression.evaluate(reverse) == is_inside
                ):
                    continue
                entering = not was_inside
                normal = event.normal
                if (np.dot(direction, normal) < 0) != entering:
                    normal = -normal
                valid.append(
                    replace(
                        event,
                        normal=normal,
                        crossing_kind="enter" if entering else "exit",
                    )
                )
            else:
                # A tangent is retained only when the solid changes across
                # its outward direction, not merely across the ray direction.
                if previous[index] != following[index]:
                    continue
                states = previous.copy()
                states[index] = not states[index]
                if solid.expression.evaluate(states) != was_inside:
                    interior = previous.copy()
                    interior[index] = True
                    normal = (
                        event.normal
                        if solid.expression.evaluate(interior)
                        else -event.normal
                    )
                    valid.append(replace(event, normal=normal, crossing_kind="touch"))
        if valid:
            selected = min(
                valid,
                key=lambda e: (
                    -abs(np.dot(direction, e.normal)),
                    e.surface_ref,
                    e.occurrence_id,
                ),
            )
            result.append(
                replace(
                    selected, metadata=RayMetadata(solid.root_id, solid.material_name)
                )
            )
    return result


@dataclass(slots=True)
class _BoundsNode:
    minimum: np.ndarray
    maximum: np.ndarray
    indices: tuple[int, ...] = ()
    children: tuple = ()


class AnalyticScene:
    def __init__(self, solids):
        self.solids = tuple(solids)
        self.minimum = (
            np.min([s.minimum for s in self.solids], axis=0)
            if self.solids
            else np.zeros(3)
        )
        self.maximum = (
            np.max([s.maximum for s in self.solids], axis=0)
            if self.solids
            else np.zeros(3)
        )

        def build(indices):
            minimum = np.min([self.solids[i].minimum for i in indices], axis=0)
            maximum = np.max([self.solids[i].maximum for i in indices], axis=0)
            if len(indices) <= 4:
                return _BoundsNode(minimum, maximum, tuple(indices))
            axis = int(np.argmax(maximum - minimum))
            ordered = sorted(
                indices,
                key=lambda i: (
                    self.solids[i].minimum[axis] + self.solids[i].maximum[axis],
                    self.solids[i].root_id,
                ),
            )
            middle = len(ordered) // 2
            return _BoundsNode(
                minimum,
                maximum,
                children=(build(ordered[:middle]), build(ordered[middle:])),
            )

        indices = [
            i
            for i, solid in enumerate(self.solids)
            if np.all(solid.minimum <= solid.maximum)
        ]
        self._bounds = build(indices) if indices else None

    @property
    def diagonal(self):
        return float(np.linalg.norm(self.maximum - self.minimum))

    def intersections(
        self, origin, direction, minimum_distance=0.0, maximum_distance=math.inf
    ):
        origin, direction = (
            np.asarray(origin, dtype=float),
            np.asarray(direction, dtype=float),
        )
        try:
            events = []
            pending = [self._bounds] if self._bounds is not None else []
            while pending:
                node = pending.pop()
                if (
                    ray_box(
                        origin,
                        direction,
                        node.minimum,
                        node.maximum,
                        minimum_distance,
                        maximum_distance,
                    )
                    is None
                ):
                    continue
                pending.extend(node.children)
                for index in node.indices:
                    solid = self.solids[index]
                    if (
                        ray_box(
                            origin,
                            direction,
                            solid.minimum,
                            solid.maximum,
                            minimum_distance,
                            maximum_distance,
                        )
                        is not None
                    ):
                        events.extend(
                            e
                            for e in solid_events(solid, origin, direction)
                            if minimum_distance <= e.distance <= maximum_distance
                        )
            events.sort(key=lambda e: (e.distance, e.surface_ref, e.occurrence_id))
            return IntersectionResult("hit" if events else "miss", tuple(events))
        except UnresolvedIntersection as error:
            return IntersectionResult("unresolved", diagnostic=str(error))

    def intersect(self, origin, direction, minimum_distance=0.0, *, previous=None):
        result = self.intersections(origin, direction, minimum_distance)
        if result.status == "unresolved":
            raise UnresolvedIntersection(result.diagnostic)
        for event in result.events:
            if (
                previous is not None
                and event.surface_ref == previous.surface_ref
                and event.occurrence_id == previous.occurrence_id
                and abs(event.distance)
                <= event.distance_error + previous.distance_error
            ):
                continue
            return event
        return None
