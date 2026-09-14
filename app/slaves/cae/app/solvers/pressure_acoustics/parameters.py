"""Read normalized Task and Material parameter values for either analysis."""

from collections.abc import Mapping


def parameter(value):
    return value["value"] if isinstance(value, Mapping) else value
