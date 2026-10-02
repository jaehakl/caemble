"""All-root isolation on a finite ray interval, with explicit uncertainty."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import mpmath
from scipy.optimize import brentq

from app.methods.geometry.interval import Dual, Interval


class UnresolvedIntersection(RuntimeError):
    """A candidate could not be excluded or resolved; it is not a miss."""


@dataclass(frozen=True, slots=True)
class Root:
    value: float
    error: float


def quadratic(a, b, c):
    scale = max(abs(a), abs(b), abs(c))
    if scale == 0:
        return []  # Ray lies in the surface; finite boundary events come from rims.
    a, b, c = a / scale, b / scale, c / scale
    if a == 0:
        return [] if b == 0 else [-c / b]
    # Extended precision avoids cancelling the two nearly equal terms.
    discriminant = np.longdouble(b) * b - 4 * np.longdouble(a) * c
    if discriminant < 0:
        return []
    if discriminant == 0:
        return [-b / (2 * a)]
    q = -0.5 * (b + math.copysign(math.sqrt(discriminant), b))
    return sorted((q / a, c / q))


def ray_box(origin, direction, minimum, maximum, lower=-math.inf, upper=math.inf):
    for o, d, low, high in zip(origin, direction, minimum, maximum):
        if d == 0:
            if o < low or o > high:
                return None
            continue
        a, b = (low - o) / d, (high - o) / d
        lower, upper = max(lower, min(a, b)), min(upper, max(a, b))
        if lower > upper:
            return None
    return float(lower), float(upper)


def isolate_roots(function, lower, upper, *, label, residual_scale=1.0):
    """Use derivative enclosures for exclusion, Newton contraction and tangency.

    Every remaining leaf must contain a converged crossing/stationary zero or raise.
    An iteration budget never turns uncertain candidates into misses.
    """
    if not math.isfinite(lower + upper):
        raise UnresolvedIntersection(f"{label}: unbounded search interval")
    scale = max(abs(lower), abs(upper), upper - lower, np.finfo(float).tiny)
    tolerance = 64 * np.finfo(float).eps * scale
    residual_tolerance = 128 * np.finfo(float).eps * residual_scale
    pending, roots, visits = [(lower, upper, 0)], [], 0
    precision = None

    def precise(t):
        nonlocal precision
        if precision is None:
            precision = mpmath.mp.clone()
            precision.dps = 80
        return function(precision.mpf(t))

    while pending:
        lo, hi, depth = pending.pop()
        visits += 1
        if visits > 100000 or depth > 96:
            raise UnresolvedIntersection(
                f"{label}: unresolved ray interval [{lo}, {hi}]"
            )
        enclosure = function(Dual(Interval(lo, hi), Interval(1, 1)))
        if not isinstance(enclosure, Dual):
            raise UnresolvedIntersection(f"{label}: missing derivative enclosure")
        value, derivative = enclosure.value, enclosure.derivative
        if value.lo > 0 or value.hi < 0:
            continue
        mid = lo + (hi - lo) / 2
        fm = float(function(mid))
        monotone = derivative.lo > 0 or derivative.hi < 0
        if monotone:
            if hi - lo <= math.sqrt(np.finfo(float).eps) * scale * 32:
                # Near a multiple root, float64 cancellation makes a whole
                # neighborhood look like zero. Resolve endpoint signs with a
                # private high-precision context instead of inventing hits.
                fl, fh = precise(lo), precise(hi)
                if fl * fh > 0:
                    continue
                root = (
                    lo
                    if fl == 0
                    else hi
                    if fh == 0
                    else brentq(
                        lambda t: float(precise(t)),
                        lo,
                        hi,
                        xtol=max(tolerance / 8, np.finfo(float).smallest_subnormal),
                        rtol=4 * np.finfo(float).eps,
                    )
                )
                roots.append(Root(root, tolerance))
                continue
            midpoint_value = function(Dual(Interval(mid, mid), Interval(1, 1))).value
            image = Interval(mid, mid) - midpoint_value / derivative
            a, b = max(lo, image.lo), min(hi, image.hi)
            if a > b:
                continue
            if b - a < 0.75 * (hi - lo) and b - a > tolerance:
                pending.append((a, b, depth + 1))
                continue
        if hi - lo <= tolerance or mid in (lo, hi):
            candidates = [(abs(float(function(t))), t) for t in (lo, mid, hi)]
            residual, root = min(candidates)
            if residual > residual_tolerance:
                raise UnresolvedIntersection(
                    f"{label}: residual {residual} in [{lo}, {hi}]"
                )
            roots.append(Root(root, max(root - lo, hi - root, tolerance)))
            continue
        # Resolve stationary zeros before interval dependency causes an
        # exponential collection of tiny cells around a multiple root.
        if not monotone and hi - lo <= math.sqrt(np.finfo(float).eps) * scale * 8:

            def slope(t):
                d = function(Dual(Interval(t, t), Interval(1, 1))).derivative
                return (d.lo + d.hi) / 2

            dl, dh = slope(lo), slope(hi)
            stationary = None
            if math.isfinite(dl + dh) and dl * dh <= 0 and dl != dh:
                stationary = brentq(
                    slope,
                    lo,
                    hi,
                    xtol=max(tolerance / 8, np.finfo(float).smallest_subnormal),
                    rtol=4 * np.finfo(float).eps,
                )
            if stationary is not None:
                fs = precise(stationary)
                if abs(fs) <= 4096 * np.finfo(float).eps ** 2 * residual_scale:
                    roots.append(Root(stationary, tolerance))
                    continue
                # A stationary point separated from zero still needs its
                # neighboring intervals checked for two close crossings.
        pending.extend(((mid, hi, depth + 1), (lo, mid, depth + 1)))
    roots.sort(key=lambda root: root.value)
    distinct = []
    for root in roots:
        if (
            distinct
            and abs(root.value - distinct[-1].value) <= root.error + distinct[-1].error
        ):
            previous = distinct[-1]
            best = min((previous, root), key=lambda r: abs(float(function(r.value))))
            distinct[-1] = Root(best.value, max(previous.error, root.error))
        else:
            distinct.append(root)
    return distinct
