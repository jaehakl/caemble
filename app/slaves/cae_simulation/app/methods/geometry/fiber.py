"""Line/Arc circular sweep with physical arc-length radius knots."""

from __future__ import annotations

import math
import numpy as np


def _rotate(vector, axis, angle):
    c, s = math.cos(angle), math.sin(angle)
    return (
        vector * c + np.cross(axis, vector) * s + axis * np.dot(axis, vector) * (1 - c)
    )


def evaluate_fiber(node, distance, theta=0.0, side="right"):
    path, knots = node["path"], node["radiusProfile"]
    point = np.array(path["start"], dtype=float)
    tangent = np.array(path["direction"], dtype=float)
    reference = np.eye(3)[np.argmin(np.abs(tangent))]
    normal = np.cross(tangent, reference)
    normal /= np.linalg.norm(normal)
    remaining, curvature = distance, np.zeros(3)
    for index, segment in enumerate(path["segments"]):
        length = (
            segment["length"]
            if segment["kind"] == "line"
            else segment["radius"] * abs(segment["angle"])
        )
        travel = min(max(remaining, 0), length)
        curvature = np.zeros(3)
        if segment["kind"] == "line":
            point += tangent * travel
        elif segment["kind"] == "arc":
            axis = np.asarray(segment["normal"], dtype=float)
            sign = math.copysign(1, segment["angle"])
            angle = sign * travel / segment["radius"]
            inward = np.cross(axis, tangent) * sign
            point += segment["radius"] * (
                tangent * math.sin(abs(angle)) + inward * (1 - math.cos(angle))
            )
            tangent, normal = (
                _rotate(tangent, axis, angle),
                _rotate(normal, axis, angle),
            )
            curvature = np.cross(axis, tangent) * sign / segment["radius"]
        else:
            raise ValueError("Fiber supports only Line/Arc segments")
        remaining -= length
        if remaining < 0 or (
            remaining == 0 and (side == "left" or index == len(path["segments"]) - 1)
        ):
            break
    index = next(
        (
            i
            for i in range(1, len(knots))
            if (
                distance <= knots[i]["s"]
                if side == "left"
                else distance < knots[i]["s"]
            )
        ),
        len(knots) - 1,
    )
    first, last = knots[index - 1], knots[index]
    slope = (last["radius"] - first["radius"]) / (last["s"] - first["s"])
    radius = first["radius"] + (distance - first["s"]) * slope
    binormal = np.cross(tangent, normal)
    radial = normal * math.cos(theta) + binormal * math.sin(theta)
    outward = (1 - radius * np.dot(curvature, radial)) * radial - slope * tangent
    return dict(
        center=point,
        tangent=tangent,
        normal=normal,
        binormal=binormal,
        radius=radius,
        position=point + radius * radial,
        outward=outward / np.linalg.norm(outward),
        derivativeS=(1 - radius * np.dot(curvature, radial)) * tangent + slope * radial,
        derivativeTheta=radius
        * (-normal * math.sin(theta) + binormal * math.cos(theta)),
    )


def validate_fiber(node):
    if (
        "path" not in node
        or "radiusProfile" not in node
        or any(
            key in node
            for key in (
                "points",
                "radii",
                "frames",
                "basePath",
                "helix",
                "fourier",
                "envelopePower",
            )
        )
    ):
        raise ValueError(
            "Sampled Fiber contract was removed; migrate source and rebuild"
        )
    path, knots = node["path"], node["radiusProfile"]
    tangent = np.asarray(path["direction"], dtype=float)
    start = np.asarray(path["start"], dtype=float)
    if (
        start.shape != (3,)
        or tangent.shape != (3,)
        or not np.all(np.isfinite(start))
        or not np.isclose(np.linalg.norm(tangent), 1)
    ):
        raise ValueError("Invalid canonical Fiber vectors")
    if len(knots) < 2 or not path["segments"] or knots[0]["s"] != 0:
        raise ValueError("Fiber requires a nonempty path and full radius profile")
    radius = max(k["radius"] for k in knots)
    lengths, angles = [], []
    for segment in path["segments"]:
        if segment["kind"] == "line":
            span, angle = segment["length"], 0.0
        elif segment["kind"] == "arc":
            axis = np.asarray(segment["normal"], dtype=float)
            angle = segment["angle"]
            if (
                not math.isfinite(angle)
                or not 0 < abs(angle) < 2 * math.pi
                or segment["radius"] <= radius
                or axis.shape != (3,)
                or not np.isclose(np.linalg.norm(axis), 1)
                or abs(np.dot(axis, tangent)) > 1e-10
            ):
                raise ValueError("Invalid Fiber arc or singular bend radius")
            span = segment["radius"] * abs(angle)
            tangent = _rotate(tangent, axis, angle)
        else:
            raise ValueError("Fiber supports only Line/Arc segments")
        if not math.isfinite(span) or span <= 0:
            raise ValueError("Fiber segment length must be finite and positive")
        lengths.append(span)
        angles.append(abs(angle))
    length = sum(lengths)
    if not math.isclose(knots[-1]["s"], length, rel_tol=1e-10, abs_tol=0):
        raise ValueError("Fiber radius profile must span full physical length")
    for index, k in enumerate(knots):
        if (
            not math.isfinite(k["radius"])
            or k["radius"] <= 0
            or not math.isfinite(k["s"])
            or (index and k["s"] <= knots[index - 1]["s"])
        ):
            raise ValueError("Invalid Fiber radius profile")

    def turning(s):
        total = 0.0
        for span, angle in zip(lengths, angles):
            total += min(s, span) * angle / span
            s -= min(s, span)
            if s == 0:
                break
        return total

    pending, visits = [(0.0, length, 0.0, length, 0)], 0
    while pending:
        a, b, c, d, depth = pending.pop()
        if turning(d) - turning(a) < math.pi / 2:
            continue
        visits += 1
        if visits > 100000 or depth > 48:
            raise ValueError(
                "Unsupported Fiber self-intersection or unresolved tube clearance"
            )
        if a == c and b == d:
            mid = (a + b) / 2
            pending.extend(
                (
                    (a, mid, a, mid, depth + 1),
                    (mid, b, mid, b, depth + 1),
                    (a, mid, mid, b, depth + 1),
                )
            )
            continue
        p, q = (
            evaluate_fiber(node, (a + b) / 2)["center"],
            evaluate_fiber(node, (c + d) / 2)["center"],
        )
        if np.linalg.norm(p - q) > (b - a + d - c) / 2 + 2 * radius:
            continue
        if b - a >= d - c:
            pending.extend(
                ((a, (a + b) / 2, c, d, depth + 1), ((a + b) / 2, b, c, d, depth + 1))
            )
        else:
            pending.extend(
                ((a, b, c, (c + d) / 2, depth + 1), (a, b, (c + d) / 2, d, depth + 1))
            )


def tessellate_fiber(node, settings=None):
    validate_fiber(node)
    settings = settings or {}
    count, steps = (
        int(settings.get("radialSegments", 12)),
        int(settings.get("pathSegments", 128)),
    )
    if (
        count < 3
        or steps < 1
        or count != settings.get("radialSegments", 12)
        or steps != settings.get("pathSegments", 128)
    ):
        raise ValueError("Invalid Fiber tessellation subdivisions")
    length = node["radiusProfile"][-1]["s"]
    boundaries, distance = [k["s"] for k in node["radiusProfile"]], 0.0
    for segment in node["path"]["segments"]:
        distance += (
            segment["length"]
            if segment["kind"] == "line"
            else segment["radius"] * abs(segment["angle"])
        )
        boundaries.append(distance)
    knots = sorted(set([0.0, length, *boundaries]))
    samples = sorted(
        [
            *knots,
            *(
                s
                for s in (i * length / steps for i in range(steps + 1))
                if not any(
                    abs(k - s) <= length * np.finfo(float).eps * 16 for k in knots
                )
            ),
        ]
    )
    points, triangles, surfaces = [], [], []
    angles = 2 * np.pi * np.arange(count) / count
    for s in samples:
        v = evaluate_fiber(node, s)
        points.extend(
            v["center"]
            + v["radius"]
            * (
                np.cos(angles)[:, None] * v["normal"]
                + np.sin(angles)[:, None] * v["binormal"]
            )
        )
    for j in range(len(samples) - 1):
        for i in range(count):
            n = (i + 1) % count
            a, b, c, d = (
                j * count + i,
                j * count + n,
                (j + 1) * count + n,
                (j + 1) * count + i,
            )
            triangles.extend(([a, b, c], [a, c, d]))
            surfaces.extend((1, 1))
    start, end, base = len(points), len(points) + 1, (len(samples) - 1) * count
    points.extend(
        (evaluate_fiber(node, 0)["center"], evaluate_fiber(node, length)["center"])
    )
    for i in range(count):
        n = (i + 1) % count
        triangles.extend(([start, n, i], [end, base + i, base + n]))
        surfaces.extend((0, 2))
    return np.asarray(points), np.asarray(triangles, dtype=np.int64), surfaces
