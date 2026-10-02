"""Fixed physical conditions, independent grating/conjugate predictions and ray refinement."""
import json
import os
from pathlib import Path
import numpy as np
import pytest
from tests.imaging_spectrometer_fixtures import trace_imager, imager_metrics


@pytest.mark.asyncio
async def test_slit_bandwidth_and_ray_refinement(catalog_builds, tmp_path):
    nominal = catalog_builds['transmission-imaging-spectrometer']['experiment']['variables']
    conditions = []
    # Thin edge isolates the independent slit-width prediction from aperture-tunnel clipping.
    for width in (.05, .1, .2):
        for rays in (128, 512):
            values = {**nominal, 'slitWidth': width, 'fieldPosition': 0, 'fieldSeparation': 0,
                      'fieldHeight': .02, 'slitCardThickness': .001, 'raysPerSource': rays}
            conditions.append((width, rays, catalog_builds.measurement('transmission-imaging-spectrometer', values)))
    rows = []
    for width, rays, measurement in conditions:
        metrics = imager_metrics(await trace_imager(measurement))
        wavelength = metrics['wavelength']
        beta = np.arcsin(wavelength * 1e-6 * 500)
        expected = 1.92 + 16 * np.tan(beta - np.arcsin(.00055 * 500))
        np.testing.assert_allclose(metrics['u'], expected, atol=.012)
        dispersion = abs((metrics['u'][1] - metrics['u'][3]) / 200)
        bandwidth = np.sqrt(12) * metrics['rms'][2] / dispersion
        assert bandwidth == pytest.approx(width / 25 * 2000, rel=.12)
        assert .003 / dispersion == pytest.approx(.36, abs=.015)
        rows.append({'slitUm': width * 1000, 'raysPerSource': rays, 'bandwidthNm': bandwidth,
                     'centersMm': metrics['u'].tolist(), 'nmPerPixel': .003 / dispersion})
    for coarse, fine in zip(rows[::2], rows[1::2]):
        assert coarse['bandwidthNm'] == pytest.approx(fine['bandwidthNm'], rel=.12)
    output = Path(os.environ.get('CAEMBLE_IMAGER_REPORT_DIR', str(tmp_path)))
    output.mkdir(parents=True, exist_ok=True)
    (output / 'slit-characterization.json').write_text(json.dumps(rows, indent=2), encoding='utf-8')


@pytest.mark.asyncio
async def test_spatial_mapping_vignetting_and_zero_order_stop(catalog_builds, tmp_path):
    nominal = catalog_builds['transmission-imaging-spectrometer']['experiment']['variables']
    variants = [
        {**nominal, 'fieldPosition': position, 'fieldSeparation': 0, 'fieldHeight': .02}
        for position in (-1.4, 0., 1.4)]
    variants += [{**variants[1], 'cameraPupilDiameter': 2},
                 {**variants[1], 'firstOrderEfficiency': 0, 'zeroOrderEfficiency': 1}]
    measurements = [catalog_builds.measurement('transmission-imaging-spectrometer', values) for values in variants]
    results = [await trace_imager(measurement) for measurement in measurements]
    metrics = [imager_metrics(result) for result in results[:3]]
    for field, values in zip((-1.4, 0., 1.4), metrics):
        # Independent vector grating equation, projected onto the tilted camera axis.
        dy = -field / 25 / np.sqrt(1 + (field / 25) ** 2)
        dx = values['wavelength'] * 1e-6 * 500
        dz = np.sqrt(1 - dx * dx - dy * dy)
        beta0 = np.arcsin(.00055 * 500)
        denominator = np.sin(beta0) * dx + np.cos(beta0) * dz
        expected = 1.08 + 16 * dy / denominator
        np.testing.assert_allclose(values['v'], expected, atol=.025)
        expected_u = 1.92 + 16 * (np.cos(beta0) * dx - np.sin(beta0) * dz) / denominator
        np.testing.assert_allclose(values['u'], expected_u, atol=.012)
        assert np.all((values['v'] > 0) & (values['v'] < 2.16))
    smile = (metrics[0]['u'] + metrics[2]['u']) / 2 - metrics[1]['u']
    assert np.all(smile > 0)
    magnification = (metrics[0]['v'] - metrics[2]['v']) / 2.8
    np.testing.assert_allclose(magnification, .64, atol=.015)
    assert results[3].observations['detectedPower'] < results[1].observations['detectedPower'] * .6
    assert results[4].observations['detectedPower'] == 0
    output = Path(os.environ.get('CAEMBLE_IMAGER_REPORT_DIR', str(tmp_path)))
    output.mkdir(parents=True, exist_ok=True)
    report = {'wavelengthsNm': metrics[1]['wavelength'].tolist(), 'smileMm': smile.tolist(),
              'magnification': magnification.tolist(),
              'fields': [{'fieldMm': field, 'uMm': values['u'].tolist(), 'vMm': values['v'].tolist()}
                         for field, values in zip((-1.4, 0., 1.4), metrics)],
              'nominalPowerW': results[1].observations['detectedPower'],
              'reducedPupilPowerW': results[3].observations['detectedPower'],
              'zeroOrderPowerW': results[4].observations['detectedPower']}
    (output / 'spatial-characterization.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
