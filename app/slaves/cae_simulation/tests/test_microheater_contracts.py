"""Small response-time calculations preserve reached versus unavailable semantics."""

import numpy as np
import pytest

from tests.microheater_fixtures import pulse_response_times


@pytest.mark.parametrize("temperature,expected", [
    ([10., 18., 20., 14., 10.], [[1.5, 1.], [1.75, 1.]]),
    ([10., 11., 12., 11.8, 11.6], [[0., 0.], [0., 0.]]),
])
def test_first_pulse_response_interpolates_crossings_and_labels_unreached_thresholds(temperature, expected):
    times = np.arange(5.)
    power = [1., 1., 0., 0.]
    np.testing.assert_allclose(pulse_response_times(times, temperature, times[1:], power, 20.), expected)
    with pytest.raises(ValueError, match="physical times differ"):
        pulse_response_times(times, temperature, times[:-1], power, 20.)
    with pytest.raises(ValueError, match="initial Heat sample"):
        pulse_response_times(times, temperature[1:], times[1:], power, 20.)
