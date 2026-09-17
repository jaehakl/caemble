"""Continuous axial solids. Mesh resolution never changes their definitions."""

from __future__ import annotations

import math
import numpy as np


def sag(face, radius):
    c, k = face["curvature"], face["conic"]
    q = np.sqrt(1 - (1 + k) * c * c * np.asarray(radius) ** 2)
    value, derivative = (
        c * np.asarray(radius) ** 2 / (1 + q),
        c * np.asarray(radius) / q,
    )
    for term in face["coefficients"]:
        value += term["value"] * np.asarray(radius) ** term["order"]
        derivative += (
            term["order"] * term["value"] * np.asarray(radius) ** (term["order"] - 1)
        )
    return value, derivative


def evaluate_surface(kind, p, surface, u, theta):
    """u: polar fraction for ellipsoids, radial fraction otherwise (side: height)."""
    cosine, sine = np.cos(theta), np.sin(theta)
    radius = p.get("radius", 0) * u
    if kind == "ellipsoid":
        a, f = p["axialRadius"], p["focalDistance"]
        b = math.sqrt((a - f) * (a + f))
        radius, z = b * np.sin(np.pi * u), -a * np.cos(np.pi * u)
        normal = np.array([radius * cosine / b**2, radius * sine / b**2, z / a**2])
    elif kind == "asphericCylinder":
        if surface == 1:
            radius = p["radius"]
            low = -p["centerThickness"] / 2 + sag(p["bottom"], radius)[0]
            high = p["centerThickness"] / 2 + sag(p["top"], radius)[0]
            z = high if u == 1 else low + (high - low) * u
            normal = np.array([cosine, sine, 0])
        else:
            sign = -1 if surface == 0 else 1
            value, derivative = sag(p["bottom"] if surface == 0 else p["top"], radius)
            z = sign * p["centerThickness"] / 2 + value
            normal = np.array(
                [-sign * derivative * cosine, -sign * derivative * sine, sign]
            )
    elif kind in {"hyperboloid", "paraboloid"}:
        evaluated_radius = p["radius"] if surface == 2 else radius
        if kind == "paraboloid":
            z = evaluated_radius**2 / (4 * p["focalLength"])
            normal = np.array(
                [
                    radius * cosine / (2 * p["focalLength"]),
                    radius * sine / (2 * p["focalLength"]),
                    -1,
                ]
            )
        else:
            a, f = p["axialRadius"], p["focalDistance"]
            b2 = (f - a) * (f + a)
            z = a * math.sqrt(1 + evaluated_radius**2 / b2)
            normal = np.array([radius * cosine / b2, radius * sine / b2, -z / a**2])
        if surface == 2:
            normal = np.array([0.0, 0.0, 1.0])
    else:
        raise ValueError(f"Unsupported continuous primitive: {kind}")
    return np.array([radius * cosine, radius * sine, z]), normal / np.linalg.norm(
        normal
    )


def evaluate_differential(kind, p, surface, u, theta, matrix=None):
    """Continuous position, partial derivatives and inverse-transpose normal."""
    valid = (
        [0]
        if kind == "ellipsoid"
        else [0, 1, 2]
        if kind == "asphericCylinder"
        else [1, 2]
    )
    if surface not in valid or not 0 <= u <= 1 or not math.isfinite(theta):
        raise ValueError("Invalid continuous surface coordinates")
    position, normal = evaluate_surface(kind, p, surface, u, theta)
    radius = np.linalg.norm(position[:2])
    dr, dz = p.get("radius", 0), 0.0
    if kind == "ellipsoid":
        a, f = p["axialRadius"], p["focalDistance"]
        dr, dz = (
            math.sqrt((a - f) * (a + f)) * math.pi * math.cos(math.pi * u),
            a * math.pi * math.sin(math.pi * u),
        )
    elif kind == "asphericCylinder":
        if surface == 1:
            dr, dz = (
                0.0,
                p["centerThickness"]
                + sag(p["top"], radius)[0]
                - sag(p["bottom"], radius)[0],
            )
        else:
            dz = sag(p["bottom"] if surface == 0 else p["top"], radius)[1] * p["radius"]
    elif surface != 2:
        dz = p["radius"] * (
            radius / (2 * p["focalLength"])
            if kind == "paraboloid"
            else p["axialRadius"] ** 2
            * radius
            / ((p["focalDistance"] ** 2 - p["axialRadius"] ** 2) * position[2])
        )
    du = np.array([dr * math.cos(theta), dr * math.sin(theta), dz])
    dv = np.array([-radius * math.sin(theta), radius * math.cos(theta), 0.0])
    if matrix is not None:
        affine = np.asarray(matrix).reshape(4, 4)
        position = affine[:3, :3] @ position + affine[:3, 3]
        du, dv = affine[:3, :3] @ du, affine[:3, :3] @ dv
        normal = np.linalg.solve(affine[:3, :3].T, normal)
        normal /= np.linalg.norm(normal)
    return dict(position=position, normal=normal, derivativeU=du, derivativeV=dv)


def validate_primitive(kind, p):
    for key in ("zMin", "zMax", "kind", "focalLengths"):
        if key in p:
            raise ValueError(
                f"{kind} does not support {key}; migrate source and rebuild"
            )
    required = {
        "ellipsoid": ("axialRadius",),
        "hyperboloid": ("axialRadius", "radius"),
        "paraboloid": ("focalLength", "radius"),
        "asphericCylinder": ("radius", "centerThickness"),
    }
    for key in required[kind]:
        if not math.isfinite(p[key]) or p[key] <= 0:
            raise ValueError(f"{key} must be finite and positive")
    if kind in {"ellipsoid", "hyperboloid"}:
        f, a = p["focalDistance"], p["axialRadius"]
        if not math.isfinite(f) or not (0 <= f < a if kind == "ellipsoid" else f > a):
            raise ValueError("Invalid focalDistance/axialRadius")
    if kind != "asphericCylinder":
        return
    for face in (p["top"], p["bottom"]):
        c, k = face["curvature"], face["conic"]
        orders = [term["order"] for term in face["coefficients"]]
        if (
            not math.isfinite(c)
            or not math.isfinite(k)
            or 1 - (1 + k) * c * c * p["radius"] ** 2 <= 0
        ):
            raise ValueError("Invalid or singular asphere aperture")
        if (
            len(set(orders)) != len(orders)
            or any(n < 4 or n % 2 or int(n) != n for n in orders)
            or any(not math.isfinite(t["value"]) for t in face["coefficients"])
        ):
            raise ValueError("Asphere requires unique even polynomial orders >= 4")

    def bounds(face, lo, hi):
        c, k = face["curvature"], face["conic"]
        intervals = []
        for r in (lo, hi):
            if c == 0 or r == 0:
                intervals.append((0.0, 0.0))
                continue
            product = (1 + k) * c * c * r * r
            domain = 1 - product
            error = (
                np.finfo(float).eps * 16 * (1 + abs(product))
                + np.finfo(float).smallest_subnormal
            )
            if not math.isfinite(domain) or domain - error <= 0:
                raise ValueError(
                    "Asphere conic domain cannot be certified over the aperture"
                )
            numerator = c * r * r
            numerator_error = (
                np.finfo(float).eps * 8 * abs(numerator)
                + np.finfo(float).smallest_subnormal
            )
            candidates = [
                n / (1 + math.sqrt(d))
                for n in (numerator - numerator_error, numerator + numerator_error)
                for d in (domain - error, domain + error)
            ]
            padding = (
                np.finfo(float).eps * 8 * max(map(abs, candidates))
                + np.finfo(float).smallest_subnormal
            )
            intervals.append((min(candidates) - padding, max(candidates) + padding))
        lower, upper = min(x[0] for x in intervals), max(x[1] for x in intervals)
        for term in face["coefficients"]:
            a, b = (
                term["value"] * lo ** term["order"],
                term["value"] * hi ** term["order"],
            )
            error = (
                np.finfo(float).eps
                * 32
                * (term["order"] + 1)
                * (abs(a) + abs(b) + abs(lower) + abs(upper))
                + np.finfo(float).smallest_subnormal
            )
            lower += min(a, b) - error
            upper += max(a, b) + error
        if not math.isfinite(lower) or not math.isfinite(upper):
            raise ValueError("Asphere interval exceeds finite numerical range")
        return lower, upper

    pending, visits = [(0.0, p["radius"], 0)], 0
    while pending:
        lo, hi, depth = pending.pop()
        t, b = bounds(p["top"], lo, hi), bounds(p["bottom"], lo, hi)
        margin = (
            np.finfo(float).eps
            * 64
            * (p["centerThickness"] + max(map(abs, t)) + max(map(abs, b)))
        )
        if p["centerThickness"] + t[0] - b[1] > margin:
            continue
        mid = (lo + hi) / 2
        if any(
            p["centerThickness"] + sag(p["top"], r)[0] - sag(p["bottom"], r)[0] <= 0
            for r in (lo, mid, hi)
        ):
            raise ValueError("AsphericCylinder surfaces intersect or touch")
        visits += 1
        if visits > 100000 or depth >= 48:
            raise ValueError(
                "AsphericCylinder positive thickness could not be certified"
            )
        pending.extend(((lo, mid, depth + 1), (mid, hi, depth + 1)))


def tessellate_primitive(kind, parameters, settings=None):
    validate_primitive(kind, parameters)
    settings = settings or {}
    count, steps = (
        int(settings.get("radialSegments", 64)),
        int(settings.get("meridianSegments", 32)),
    )
    if (
        count < 3
        or steps < 2
        or count != settings.get("radialSegments", 64)
        or steps != settings.get("meridianSegments", 32)
    ):
        raise ValueError("Invalid tessellation subdivisions")
    points, triangles, surfaces, ids = [], [], [], {}

    def vertex(surface, u, index):
        point, _ = evaluate_surface(
            kind, parameters, surface, u, 2 * np.pi * index / count
        )
        if (
            (u == 0 and surface != 1)
            or (kind == "ellipsoid" and u in (0, 1))
            or (kind in {"hyperboloid", "paraboloid"} and u == 0)
        ):
            point[:2] = 0
        key = tuple(point)
        if key not in ids:
            ids[key] = len(points)
            points.append(point)
        return ids[key]

    def patch(surface, reverse, divisions):
        rings = [
            [vertex(surface, j / divisions, i) for i in range(count)]
            for j in range(divisions + 1)
        ]
        for j in range(divisions):
            for i in range(count):
                n = (i + 1) % count
                a, b, c, d = rings[j][i], rings[j][n], rings[j + 1][n], rings[j + 1][i]
                for face in ([a, b, c], [a, c, d]):
                    if len(set(face)) < 3:
                        continue
                    triangles.append(face[::-1] if reverse else face)
                    surfaces.append(surface)

    if kind == "ellipsoid":
        patch(0, False, steps)
    elif kind == "asphericCylinder":
        patch(0, False, steps)
        patch(1, False, 1)
        patch(2, True, steps)
    else:
        patch(1, False, steps)
        patch(2, True, 1)
    return np.asarray(points), np.asarray(triangles, dtype=np.int64), surfaces
