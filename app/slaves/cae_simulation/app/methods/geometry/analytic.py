"""Continuous solid topology, surface charts and conservative enclosures.

No tessellator or mesh backend participates in this representation. Parameters
stay in canonical local units; the affine matrix includes the Solver unit scale.
"""

from __future__ import annotations

import math
import json
from dataclasses import dataclass, field

import numpy as np

from .continuous import sag, sag_squared, validate_primitive
from .curved import curved_radius
from .fiber import evaluate_fiber, validate_fiber
from .interval import Dual, Interval, as_interval, atan2, cos, sin, sqrt


@dataclass(frozen=True, order=True, slots=True)
class SurfaceRef:
    root_id: str
    source_node_id: str
    surface_index: int


@dataclass(slots=True)
class FiberSpan:
    start: float
    end: float
    frame: dict
    slope: float
    bend_radius: float = 0.0
    axis: np.ndarray | None = None

    def coordinates(self, point):
        relative = point - self.frame["center"]
        if self.bend_radius == 0:
            distance = float(np.dot(relative, self.frame["tangent"]))
            center = self.frame["center"] + distance * self.frame["tangent"]
        else:
            inward = np.cross(self.axis, self.frame["tangent"])
            bend_center = self.frame["center"] + inward * self.bend_radius
            relative = point - bend_center
            angle = math.atan2(
                np.dot(relative, self.frame["tangent"]), -np.dot(relative, inward)
            )
            distance = self.bend_radius * angle
            center = bend_center + self.bend_radius * (
                -inward * math.cos(angle) + self.frame["tangent"] * math.sin(angle)
            )
        return (
            self.start + distance,
            center,
            self.frame["radius"] + self.slope * distance,
        )

    def expression(self, s, theta):
        travel = s - self.start
        f = self.frame
        if self.bend_radius == 0:
            center = [f["center"][i] + travel * f["tangent"][i] for i in range(3)]
            normal, binormal = f["normal"], f["binormal"]
        else:
            angle = travel / self.bend_radius
            inward = np.cross(self.axis, f["tangent"])
            center = [
                f["center"][i]
                + self.bend_radius
                * (f["tangent"][i] * sin(angle) + inward[i] * (1 - cos(angle)))
                for i in range(3)
            ]
            frames = []
            for vector in (f["normal"], f["binormal"]):
                cross, dot = np.cross(self.axis, vector), np.dot(self.axis, vector)
                frames.append(
                    [
                        vector[i] * cos(angle)
                        + cross[i] * sin(angle)
                        + self.axis[i] * dot * (1 - cos(angle))
                        for i in range(3)
                    ]
                )
            normal, binormal = frames
        radius = f["radius"] + travel * self.slope
        return [
            center[i] + radius * (normal[i] * cos(theta) + binormal[i] * sin(theta))
            for i in range(3)
        ]


@dataclass(slots=True)
class SurfacePatch:
    leaf: AnalyticLeaf
    surface_index: int
    span: FiberSpan | None = None
    u_range: tuple[float, float] = (0.0, 1.0)
    v_range: tuple[float, float] = (0.0, 2 * math.pi)

    @property
    def reference(self):
        return SurfaceRef(
            self.leaf.root_id, self.leaf.node["nodeId"], self.surface_index
        )

    def expression(self, u, v):
        leaf, surface = self.leaf, self.surface_index
        p, kind = leaf.parameters, leaf.kind
        c, s = cos(v), sin(v)
        if kind == "box":
            axis, high = divmod(surface, 2)
            axes = [i for i in range(3) if i != axis]
            point = [0.0, 0.0, 0.0]
            point[axis] = p["size"][axis] * (high - 0.5)
            point[axes[0]] = (u - 0.5) * p["size"][axes[0]]
            point[axes[1]] = (v - 0.5) * p["size"][axes[1]]
            return point
        if kind in {"sphere", "ellipsoid"}:
            a = p["radius"] if kind == "sphere" else p["axialRadius"]
            b = (
                a
                if kind == "sphere"
                else math.sqrt((a - p["focalDistance"]) * (a + p["focalDistance"]))
            )
            radius = b * sin(math.pi * u)
            return [radius * c, radius * s, -a * cos(math.pi * u)]
        if kind == "fiber":
            if surface == 1:
                return self.span.expression(u, v)
            f = evaluate_fiber(
                leaf.node, 0 if surface == 0 else leaf.node["radiusProfile"][-1]["s"]
            )
            return [
                f["center"][i]
                + u * f["radius"] * (f["normal"][i] * c + f["binormal"][i] * s)
                for i in range(3)
            ]
        if kind in {"cylinder", "curvedEdgeCylinder"}:
            z = (
                (u - 0.5) * p["height"]
                if surface == 1
                else (surface - 1) * p["height"] / 2
            )
            if kind == "cylinder":
                r = p["radius"] + (z / p["height"] + 0.5) * (
                    p["radius_2"] - p["radius"]
                )
            else:
                r = curved_radius(p, z, v)[0]
            radius = r if surface == 1 else r * u
            return [radius * c, radius * s, z]
        radius = (
            p["radius"]
            if surface == 1 and kind == "asphericCylinder"
            else p["radius"] * u
        )
        if kind == "asphericCylinder":
            low = -p["centerThickness"] / 2 + sag(p["bottom"], radius)[0]
            high = p["centerThickness"] / 2 + sag(p["top"], radius)[0]
            z = (
                low + u * (high - low)
                if surface == 1
                else low
                if surface == 0
                else high
            )
        elif kind == "paraboloid":
            r = p["radius"] if surface == 2 else radius
            z = r**2 / (4 * p["focalLength"])
        elif kind == "hyperboloid":
            r = p["radius"] if surface == 2 else radius
            a, f = p["axialRadius"], p["focalDistance"]
            z = a * sqrt(1 + r**2 / ((f - a) * (f + a)))
        else:
            raise ValueError(f"Unsupported continuous primitive {kind}")
        return [radius * c, radius * s, z]

    def evaluate(self, u, v):
        values = self.expression(Dual(Interval(u, u), Interval(1, 1)), v)
        position = np.array(
            [
                (x.value.lo + x.value.hi) / 2 if isinstance(x, Dual) else float(x)
                for x in values
            ]
        )
        du = np.array(
            [
                (x.derivative.lo + x.derivative.hi) / 2 if isinstance(x, Dual) else 0.0
                for x in values
            ]
        )
        values = self.expression(u, Dual(Interval(v, v), Interval(1, 1)))
        dv = np.array(
            [
                (x.derivative.lo + x.derivative.hi) / 2 if isinstance(x, Dual) else 0.0
                for x in values
            ]
        )
        normal = np.cross(du, dv)
        kind, surface = self.leaf.kind, self.surface_index
        orientation = 1 if surface == 2 else -1
        if kind in {"sphere", "ellipsoid"}:
            orientation = -1
        if kind == "box":
            axis, high = divmod(surface, 2)
            orientation = (2 * high - 1) * (1 if axis != 1 else -1)
        normal *= orientation
        if np.linalg.norm(normal) == 0:
            # Polar coordinates degenerate at regular poles; the surface does not.
            if kind in {"sphere", "ellipsoid"}:
                normal = np.array([0.0, 0.0, -1.0 if u < 0.5 else 1.0])
            elif kind in {"asphericCylinder", "paraboloid", "hyperboloid"}:
                normal = np.array([0.0, 0.0, 1.0 if surface == 2 else -1.0])
            elif kind in {"cylinder", "curvedEdgeCylinder"} and surface != 1:
                normal = np.array([0.0, 0.0, 1.0 if surface == 2 else -1.0])
            elif kind == "fiber" and surface != 1:
                normal = evaluate_fiber(
                    self.leaf.node,
                    0 if surface == 0 else self.leaf.node["radiusProfile"][-1]["s"],
                )["tangent"] * (-1 if surface == 0 else 1)
            else:
                raise ValueError(f"Nonregular surface {self.reference} at {(u, v)}")
        affine = self.leaf.matrix
        world = affine[:3, :3] @ position + affine[:3, 3]
        normal = self.leaf.inverse[:3, :3].T @ normal
        normal /= np.linalg.norm(normal)
        return world, normal, affine[:3, :3] @ du, affine[:3, :3] @ dv

    def derivative_bounds(self, u, v):
        first = self.expression(Dual(u, Interval(1, 1)), v)
        second = self.expression(u, Dual(v, Interval(1, 1)))
        du = [x.derivative if isinstance(x, Dual) else Interval(0, 0) for x in first]
        dv = [x.derivative if isinstance(x, Dual) else Interval(0, 0) for x in second]
        a = self.leaf.matrix[:3, :3]
        return (
            [sum(a[i, j] * du[j] for j in range(3)) for i in range(3)],
            [sum(a[i, j] * dv[j] for j in range(3)) for i in range(3)],
        )

    def enclosure(self, urange=None, vrange=None, *, derivatives=False):
        u, v = Interval(*(urange or self.u_range)), Interval(*(vrange or self.v_range))
        if derivatives:
            du, dv = self.derivative_bounds(u, v)
            cross = [
                du[1] * dv[2] - du[2] * dv[1],
                du[2] * dv[0] - du[0] * dv[2],
                du[0] * dv[1] - du[1] * dv[0],
            ]
            return math.sqrt(sum(x.magnitude**2 for x in cross))
        point = self.expression(u, v)
        a = self.leaf.matrix
        point = [
            as_interval(sum(a[i, j] * point[j] for j in range(3)) + a[i, 3])
            for i in range(3)
        ]
        return np.array([x.lo for x in point]), np.array([x.hi for x in point])


@dataclass(slots=True)
class AnalyticLeaf:
    node: dict
    root_id: str
    occurrence_id: tuple[int, ...]
    matrix: np.ndarray
    inverse: np.ndarray = field(init=False)
    patches: list[SurfacePatch] = field(default_factory=list)
    spans: list[FiberSpan] = field(default_factory=list)
    minimum: np.ndarray = field(init=False)
    maximum: np.ndarray = field(init=False)

    @property
    def kind(self):
        return "fiber" if self.node["kind"] == "fiber" else self.node["primitive"]

    @property
    def parameters(self):
        return self.node.get("parameters", {})

    def __post_init__(self):
        self.inverse = np.linalg.inv(self.matrix)
        kind, p = self.kind, self.parameters
        if kind in {"ellipsoid", "paraboloid", "hyperboloid", "asphericCylinder"}:
            validate_primitive(kind, p)
        if kind == "fiber":
            validate_fiber(self.node)
            start = 0.0
            knots = self.node["radiusProfile"]
            for segment in self.node["path"]["segments"]:
                length = (
                    segment["length"]
                    if segment["kind"] == "line"
                    else segment["radius"] * abs(segment["angle"])
                )
                count = (
                    1
                    if segment["kind"] == "line"
                    else math.ceil(abs(segment["angle"]) / (math.pi / 2))
                )
                divisions = sorted(
                    {
                        start,
                        start + length,
                        *(k["s"] for k in knots if start < k["s"] < start + length),
                        *(start + length * i / count for i in range(1, count)),
                    }
                )
                for first, last in zip(divisions, divisions[1:]):
                    frame = evaluate_fiber(self.node, first)
                    middle = (first + last) / 2
                    index = next(
                        i for i in range(1, len(knots)) if middle < knots[i]["s"]
                    )
                    slope = (knots[index]["radius"] - knots[index - 1]["radius"]) / (
                        knots[index]["s"] - knots[index - 1]["s"]
                    )
                    span = FiberSpan(first, last, frame, slope)
                    if segment["kind"] == "arc":
                        span.bend_radius = segment["radius"]
                        span.axis = np.asarray(segment["normal"]) * math.copysign(
                            1, segment["angle"]
                        )
                    self.spans.append(span)
                    self.patches.append(SurfacePatch(self, 1, span, (first, last)))
                start += length
            self.patches.extend((SurfacePatch(self, 0), SurfacePatch(self, 2)))
        else:
            surfaces = (
                range(6)
                if kind == "box"
                else (0,)
                if kind in {"sphere", "ellipsoid"}
                else (1, 2)
                if kind in {"paraboloid", "hyperboloid"}
                else (0, 1, 2)
            )
            self.patches = [
                SurfacePatch(
                    self, s, v_range=(0, 1) if kind == "box" else (0, 2 * math.pi)
                )
                for s in surfaces
            ]
        if kind == "curvedEdgeCylinder":
            pending = [((-p["height"] / 2, p["height"] / 2), (0, 2 * math.pi), 0)]
            while pending:
                z, theta, depth = pending.pop()
                radius = curved_radius(p, Interval(*z), Interval(*theta))[0]
                if radius.lo > 0:
                    continue
                if radius.hi <= 0 or depth >= 48:
                    raise ValueError(
                        f"Nonregular CurvedEdgeCylinder {self.root_id}: positive radius cannot be certified at {z}, {theta}"
                    )
                if depth % 2:
                    mid = sum(z) / 2
                    pending.extend(
                        (
                            ((z[0], mid), theta, depth + 1),
                            ((mid, z[1]), theta, depth + 1),
                        )
                    )
                else:
                    mid = sum(theta) / 2
                    pending.extend(
                        (
                            (z, (theta[0], mid), depth + 1),
                            (z, (mid, theta[1]), depth + 1),
                        )
                    )
        bounds = [patch.enclosure() for patch in self.patches]
        self.minimum = np.min([b[0] for b in bounds], axis=0)
        self.maximum = np.max([b[1] for b in bounds], axis=0)

    def contains(self, world, *, strict=False):
        point = self.inverse[:3, :3] @ world + self.inverse[:3, 3]
        x, y, z = point
        p, kind, r2 = self.parameters, self.kind, x * x + y * y
        if kind == "box":
            return (
                bool(np.all(np.abs(point) < np.asarray(p["size"]) / 2))
                if strict
                else bool(np.all(np.abs(point) <= np.asarray(p["size"]) / 2))
            )
        if kind in {"sphere", "ellipsoid"}:
            a = p["radius"] if kind == "sphere" else p["axialRadius"]
            b2 = (
                a * a
                if kind == "sphere"
                else (a - p["focalDistance"]) * (a + p["focalDistance"])
            )
            return (
                r2 / b2 + z * z / (a * a) < 1
                if strict
                else r2 / b2 + z * z / (a * a) <= 1
            )
        if kind == "fiber":
            for span in self.spans:
                s, center, radius = span.coordinates(point)
                if strict and not 0 < s < self.node["radiusProfile"][-1]["s"]:
                    continue
                radial_inside = (
                    np.dot(point - center, point - center) < radius**2
                    if strict
                    else np.dot(point - center, point - center) <= radius**2
                )
                if span.start <= s <= span.end and radial_inside:
                    return True
            return False
        if kind in {"cylinder", "curvedEdgeCylinder"}:
            if abs(z) >= p["height"] / 2 if strict else abs(z) > p["height"] / 2:
                return False
            radius = (
                (p["radius"] + (z / p["height"] + 0.5) * (p["radius_2"] - p["radius"]))
                if kind == "cylinder"
                else curved_radius(p, z, math.atan2(y, x))[0]
            )
            return r2 < radius**2 if strict else r2 <= radius**2
        if r2 > p["radius"] ** 2:
            return False
        radius = math.sqrt(r2)
        if kind == "asphericCylinder":
            low = -p["centerThickness"] / 2 + sag(p["bottom"], radius)[0]
            high = p["centerThickness"] / 2 + sag(p["top"], radius)[0]
            return low < z < high if strict else low <= z <= high
        if kind == "paraboloid":
            low, high = (
                r2 / (4 * p["focalLength"]),
                p["radius"] ** 2 / (4 * p["focalLength"]),
            )
            return low < z < high if strict else low <= z <= high
        a, f = p["axialRadius"], p["focalDistance"]
        b2 = (f - a) * (f + a)
        low, high = a * math.sqrt(1 + r2 / b2), a * math.sqrt(1 + p["radius"] ** 2 / b2)
        return low < z < high if strict else low <= z <= high

    def classify_box(self, minimum, maximum):
        """Return {False}, {True}, or both when the enclosure straddles a boundary."""
        w = [Interval(a, b) for a, b in zip(minimum, maximum)]
        a = self.inverse
        x, y, z = [sum(a[i, j] * w[j] for j in range(3)) + a[i, 3] for i in range(3)]
        p, kind = self.parameters, self.kind
        r2 = x**2 + y**2
        constraints = []
        if kind == "box":
            constraints = [
                q**2 - (size / 2) ** 2 for q, size in zip((x, y, z), p["size"])
            ]
        elif kind in {"sphere", "ellipsoid"}:
            axial = p["radius"] if kind == "sphere" else p["axialRadius"]
            b2 = (
                axial**2
                if kind == "sphere"
                else (axial - p["focalDistance"]) * (axial + p["focalDistance"])
            )
            constraints = [r2 / b2 + z**2 / axial**2 - 1]
        elif kind in {"cylinder", "curvedEdgeCylinder"}:
            radius = (
                p["radius"] + (z / p["height"] + 0.5) * (p["radius_2"] - p["radius"])
                if kind == "cylinder"
                else curved_radius(p, z, atan2(y, x))[0]
            )
            constraints = [z - p["height"] / 2, -z - p["height"] / 2, r2 - radius**2]
        elif kind in {"asphericCylinder", "paraboloid", "hyperboloid"}:
            constraints = [r2 - p["radius"] ** 2]
            if r2.lo > p["radius"] ** 2:
                return frozenset((False,))
            radial = Interval(max(0, r2.lo), min(p["radius"] ** 2, r2.hi))
            if kind == "asphericCylinder":
                low = -p["centerThickness"] / 2 + sag_squared(p["bottom"], radial)
                high = p["centerThickness"] / 2 + sag_squared(p["top"], radial)
            elif kind == "paraboloid":
                low, high = (
                    radial / (4 * p["focalLength"]),
                    p["radius"] ** 2 / (4 * p["focalLength"]),
                )
            else:
                axial, f = p["axialRadius"], p["focalDistance"]
                b2 = (f - axial) * (f + axial)
                low, high = (
                    axial * sqrt(1 + radial / b2),
                    axial * math.sqrt(1 + p["radius"] ** 2 / b2),
                )
            constraints.extend((low - z, z - high))
        else:
            possible = False
            for span in self.spans:
                relative = [q - c for q, c in zip((x, y, z), span.frame["center"])]
                if span.bend_radius == 0:
                    travel = sum(q * t for q, t in zip(relative, span.frame["tangent"]))
                    radial = [
                        q - travel * t for q, t in zip(relative, span.frame["tangent"])
                    ]
                    radius = span.frame["radius"] + span.slope * travel
                    residual = sum(q**2 for q in radial) - radius**2
                else:
                    inward = np.cross(span.axis, span.frame["tangent"])
                    relative = [
                        q - span.bend_radius * t for q, t in zip(relative, inward)
                    ]
                    xx = -sum(q * t for q, t in zip(relative, inward))
                    yy = sum(q * t for q, t in zip(relative, span.frame["tangent"]))
                    zz = sum(q * t for q, t in zip(relative, span.axis))
                    travel = span.bend_radius * atan2(yy, xx)
                    radius = span.frame["radius"] + span.slope * travel
                    residual = (
                        (sqrt(xx**2 + yy**2) - span.bend_radius) ** 2
                        + zz**2
                        - radius**2
                    )
                if (
                    travel.hi < 0
                    or travel.lo > span.end - span.start
                    or residual.lo > 0
                ):
                    continue
                possible = True
                if (
                    travel.lo >= 0
                    and travel.hi <= span.end - span.start
                    and residual.hi < 0
                ):
                    return frozenset((True,))
            return frozenset((False, True)) if possible else frozenset((False,))
        if any(c.lo > 0 for c in constraints):
            return frozenset((False,))
        if all(c.hi < 0 for c in constraints):
            return frozenset((True,))
        return frozenset((False, True))


@dataclass(slots=True)
class SolidExpression:
    operation: str
    children: tuple

    def evaluate(self, states):
        values = [
            states[c] if isinstance(c, int) else c.evaluate(states)
            for c in self.children
        ]
        if self.operation == "union":
            return any(values)
        if self.operation == "intersect":
            return all(values)
        return values[0] and not any(values[1:])

    def possibilities(self, states):
        values = [
            states[c] if isinstance(c, int) else c.possibilities(states)
            for c in self.children
        ]
        if self.operation == "subtract":
            values = [
                values[0],
                *(frozenset(not v for v in value) for value in values[1:]),
            ]
        is_union = self.operation == "union"
        result = frozenset((False if is_union else True,))
        for value in values:
            result = frozenset(
                (a or b) if is_union else (a and b) for a in result for b in value
            )
        return result

    def bounds(self, leaves):
        children = [
            (leaves[c].minimum, leaves[c].maximum)
            if isinstance(c, int)
            else c.bounds(leaves)
            for c in self.children
        ]
        if self.operation == "subtract":
            return children[0]
        if self.operation == "intersect":
            return np.max([b[0] for b in children], axis=0), np.min(
                [b[1] for b in children], axis=0
            )
        return np.min([b[0] for b in children], axis=0), np.max(
            [b[1] for b in children], axis=0
        )


class AnalyticSolid:
    def __init__(self, root, scale=1.0):
        self.root_id = root["id"]
        self.material_name = (root.get("material") or {}).get("name")
        self.leaves = []

        def compile_node(node, matrix, path):
            if node["kind"] in {"transform", "instance"}:
                return compile_node(
                    node["child"],
                    matrix @ np.asarray(node["matrix"]).reshape(4, 4),
                    (*path, 0),
                )
            if node["kind"] == "boolean":
                return SolidExpression(
                    node["operation"],
                    tuple(
                        compile_node(c, matrix, (*path, i))
                        for i, c in enumerate(node["children"])
                    ),
                )
            index = len(self.leaves)
            self.leaves.append(AnalyticLeaf(node, self.root_id, path, matrix))
            return index

        matrix = np.diag([scale, scale, scale, 1.0])
        expression = compile_node(root["node"], matrix, ())
        self.expression = (
            expression
            if isinstance(expression, SolidExpression)
            else SolidExpression("union", (expression,))
        )
        self.minimum, self.maximum = self.expression.bounds(self.leaves)
        self.patches = [p for leaf in self.leaves for p in leaf.patches]
        signatures = []
        for leaf in self.leaves:
            definition = {
                key: value
                for key, value in leaf.node.items()
                if key not in {"nodeId", "tessellation"}
            }
            if "parameters" in definition:
                definition["parameters"] = {
                    key: value
                    for key, value in definition["parameters"].items()
                    if key
                    not in {
                        "segments",
                        "azimuthalSegments",
                        "verticalSegments",
                        "radialSegments",
                        "meridianSegments",
                    }
                }
            signatures.append(
                (json.dumps(definition, sort_keys=True), tuple(leaf.matrix.ravel()))
            )
        self.equivalent_leaves = [
            tuple(j for j, other in enumerate(signatures) if signature == other)
            for signature in signatures
        ]

    def contains(self, point):
        return self.expression.evaluate([leaf.contains(point) for leaf in self.leaves])

    def boundary_normal(self, patch, point, normal):
        # Resolve topology symbolically first. Only coincident, otherwise
        # ambiguous boundaries need the rounding-error offsets below.
        states = [leaf.contains(point) for leaf in self.leaves]
        index = next(i for i, leaf in enumerate(self.leaves) if leaf is patch.leaf)
        for equivalent in self.equivalent_leaves[index]:
            states[equivalent] = True
        inside = self.expression.evaluate(states)
        for equivalent in self.equivalent_leaves[index]:
            states[equivalent] = False
        outside = self.expression.evaluate(states)
        if inside == outside:
            # Coincident leaves must change together, including duplicate
            # unions and a solid subtracted from itself.
            distance = (
                64
                * np.finfo(float).eps
                * max(
                    np.linalg.norm(point),
                    np.linalg.norm(patch.leaf.maximum - patch.leaf.minimum),
                )
            )
            inside = self.contains(point - distance * normal)
            outside = self.contains(point + distance * normal)
            if inside == outside:
                return None
        return normal if inside else -normal

    def boundary_possible(self, patch, minimum, maximum):
        states = [leaf.classify_box(minimum, maximum) for leaf in self.leaves]
        index = next(i for i, leaf in enumerate(self.leaves) if leaf is patch.leaf)
        for equivalent in self.equivalent_leaves[index]:
            states[equivalent] = frozenset((True,))
        inside = self.expression.possibilities(states)
        for equivalent in self.equivalent_leaves[index]:
            states[equivalent] = frozenset((False,))
        outside = self.expression.possibilities(states)
        return not (inside == outside and len(inside) == 1)
