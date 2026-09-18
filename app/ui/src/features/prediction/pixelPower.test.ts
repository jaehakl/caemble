// @vitest-environment node
import { expect, it } from 'vitest'
import { buildPredictionKnnModel, predictWithKnn, selectPredictionCohort, type PredictionTensorSample } from './knn'

it('predicts pixel power without paths and excludes different pixels or source frequencies', () => {
  const variable = (value: number): PredictionTensorSample => ({
    layout: { key: 'spacing', dtype: 'float64', shape: [] },
    values: [value],
  })
  const pixels = (value: number, count = 2, frequency = 5e14): PredictionTensorSample => ({
    layout: {
      key: 'detectorPower',
      dtype: 'float64',
      shape: [count, 1, 1, 1, 1, 1, 1],
      quantityKind: 'optics.RadiantFlux',
      unit: 'W',
      tensorOrder: 0,
      axes: [
        { name: 'x', ticks: Array.from({ length: count }, (_, i) => ((i + 0.5) * 2) / count), unit: 'm' },
        { name: 'y', ticks: [0.5], unit: 'm' },
        { name: 'z', ticks: [0.1], unit: 'm' },
        { name: 'time', ticks: [0], unit: 's' },
        { name: 'frequency', ticks: [frequency], unit: 'Hz' },
        { name: 'amplitudePhase', ticks: ['value'] },
        { name: 'component', ticks: ['value'] },
      ],
      boxGrid: {
        version: 1,
        sampling: 'surface-integral',
        frequencyKind: 'source-sampled',
        components: ['value'],
        channels: ['value'],
        channelUnits: ['W'],
        origin: [0, 0, -0.1],
        size: [2, 1, 0.2],
        rotation: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        lengthUnit: 'm',
        gridShape: [count, 1, 1],
        source: 'experiment',
        rootId: 'sensor',
      },
    },
    values: Array.from({ length: count }, () => value),
  })
  const options = {
    direction: 'forward' as const,
    fingerprint: 'pixel-power',
    inputKeys: ['spacing'],
    outputKeys: ['detectorPower'],
    k: 2,
    rows: [
      { measurementId: 1, inputs: [variable(0)], outputs: [pixels(1)] },
      { measurementId: 2, inputs: [variable(2)], outputs: [pixels(3)] },
      { measurementId: 3, inputs: [variable(1)], outputs: [pixels(5, 3)] },
      { measurementId: 4, inputs: [variable(1)], outputs: [pixels(7, 2, 6e14)] },
    ],
  }
  const cohort = selectPredictionCohort(options)
  expect(cohort.summary.includedMeasurementIds).toEqual([1, 2])
  expect(cohort.summary.excluded['layout-mismatch']).toBe(2)
  const predicted = predictWithKnn(buildPredictionKnnModel(options), [variable(1)])
  expect(predicted.output[0].values).toEqual([2, 2])
  expect(predicted.output[0].layout.boxGrid?.sampling).toBe('surface-integral')
})
