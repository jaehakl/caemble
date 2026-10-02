"""Outward-rounded scalar intervals for continuous geometry enclosures.

These are bounds, never sampled approximations to a surface. Dual intervals
carry a first derivative for the ray root isolator.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True, slots=True)
class Interval:
    lo: float
    hi: float

    @staticmethod
    def rounded(lo, hi):
        return Interval(
            math.nextafter(float(lo), -math.inf), math.nextafter(float(hi), math.inf)
        )

    def __add__(self, other):
        if isinstance(other, Dual):
            return NotImplemented
        other = as_interval(other)
        return Interval.rounded(self.lo + other.lo, self.hi + other.hi)

    __radd__ = __add__

    def __neg__(self):
        return Interval(-self.hi, -self.lo)

    def __sub__(self, other):
        return self + -other

    def __rsub__(self, other):
        return -self + other

    def __mul__(self, other):
        if isinstance(other, Dual):
            return NotImplemented
        other = as_interval(other)
        products = [a * b for a in (self.lo, self.hi) for b in (other.lo, other.hi)]
        if any(math.isnan(p) for p in products):
            return Interval(-math.inf, math.inf)
        return Interval.rounded(min(products), max(products))

    __rmul__ = __mul__

    def __truediv__(self, other):
        other = as_interval(other)
        if other.lo <= 0 <= other.hi:
            return Interval(-math.inf, math.inf)
        return self * Interval.rounded(1 / other.hi, 1 / other.lo)

    def __rtruediv__(self, other):
        return as_interval(other) / self

    def __pow__(self, power):
        if int(power) != power or power < 0:
            raise ValueError("Interval powers require nonnegative integers")
        if power == 0:
            return Interval(1.0, 1.0)
        values = [self.lo**power, self.hi**power]
        lo = 0.0 if power % 2 == 0 and self.lo <= 0 <= self.hi else min(values)
        return Interval.rounded(lo, max(values))

    @property
    def magnitude(self):
        return max(abs(self.lo), abs(self.hi))


def as_interval(value):
    if isinstance(value, Interval):
        return value
    return Interval(float(value), float(value))


@dataclass(frozen=True, slots=True)
class Dual:
    value: Interval
    derivative: Interval

    def __add__(self, other):
        if not isinstance(other, Dual):
            other = Dual(as_interval(other), Interval(0, 0))
        return Dual(self.value + other.value, self.derivative + other.derivative)

    __radd__ = __add__

    def __neg__(self):
        return Dual(-self.value, -self.derivative)

    def __sub__(self, other):
        return self + -other

    def __rsub__(self, other):
        return -self + other

    def __mul__(self, other):
        if not isinstance(other, Dual):
            other = Dual(as_interval(other), Interval(0, 0))
        return Dual(
            self.value * other.value,
            self.derivative * other.value + self.value * other.derivative,
        )

    __rmul__ = __mul__

    def __truediv__(self, other):
        if not isinstance(other, Dual):
            other = Dual(as_interval(other), Interval(0, 0))
        return Dual(
            self.value / other.value,
            (self.derivative * other.value - self.value * other.derivative)
            / other.value**2,
        )

    def __rtruediv__(self, other):
        return Dual(as_interval(other), Interval(0, 0)) / self

    def __pow__(self, power):
        if power == 0:
            return Dual(Interval(1, 1), Interval(0, 0))
        return Dual(
            self.value**power, power * self.value ** (power - 1) * self.derivative
        )


def sqrt(value):
    if hasattr(value, "_mpf_"):
        return value.context.sqrt(value)
    if isinstance(value, Dual):
        root = sqrt(value.value)
        return Dual(root, value.derivative / (2 * root))
    if isinstance(value, Interval):
        if value.hi < 0:
            raise ValueError("Negative square-root interval")
        return Interval.rounded(
            math.sqrt(max(0, value.lo)), math.sqrt(max(0, value.hi))
        )
    return np.sqrt(value)


def sin(value):
    if hasattr(value, "_mpf_"):
        return value.context.sin(value)
    if isinstance(value, Dual):
        return Dual(sin(value.value), cos(value.value) * value.derivative)
    if not isinstance(value, Interval):
        return np.sin(value)
    if not math.isfinite(value.lo + value.hi) or value.hi - value.lo >= 2 * math.pi:
        return Interval(-1, 1)
    values = [math.sin(value.lo), math.sin(value.hi)]
    first = math.ceil((value.lo - math.pi / 2) / math.pi)
    last = math.floor((value.hi - math.pi / 2) / math.pi)
    values.extend((-1.0) ** i for i in range(first, last + 1))
    return Interval.rounded(min(values), max(values))


def cos(value):
    if hasattr(value, "_mpf_"):
        return value.context.cos(value)
    if isinstance(value, Dual):
        return Dual(cos(value.value), -sin(value.value) * value.derivative)
    if isinstance(value, Interval):
        return sin(value + math.pi / 2)
    return np.cos(value)


def atan2(y, x):
    if hasattr(x, "_mpf_") or hasattr(y, "_mpf_"):
        context = x.context if hasattr(x, "_mpf_") else y.context
        return context.atan2(y, x)
    if isinstance(x, Dual) or isinstance(y, Dual):
        x = x if isinstance(x, Dual) else Dual(as_interval(x), Interval(0, 0))
        y = y if isinstance(y, Dual) else Dual(as_interval(y), Interval(0, 0))
        return Dual(
            atan2(y.value, x.value),
            (x.value * y.derivative - y.value * x.derivative)
            / (x.value**2 + y.value**2),
        )
    if isinstance(x, Interval) or isinstance(y, Interval):
        x, y = as_interval(x), as_interval(y)
        if (x.lo <= 0 <= x.hi and y.lo <= 0 <= y.hi) or (
            x.lo < 0 and y.lo <= 0 <= y.hi
        ):
            return Interval(-math.pi, math.pi)
        angles = [math.atan2(a, b) for a in (y.lo, y.hi) for b in (x.lo, x.hi)]
        return Interval.rounded(min(angles), max(angles))
    return math.atan2(y, x)
