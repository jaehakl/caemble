/** Regenerate this checked fixture from the real browser numerical implementation. */
import { writeFileSync } from 'node:fs'
import { buildPredictionKnnModel, predictWithKnn } from '../../../ui/src/features/prediction/knn'

const sample = (key: string, values: number[], shape: number[] = [], extra = {}) => ({
  layout: { key, dtype: 'float64' as const, shape, ...extra }, values,
})
const variable = (values: number[]) => sample('x', values, values.length === 1 ? [] : [values.length], { minimum: 0, maximum: 2 })
const scalarRows = [0, 1, 2].map((x, index) => ({
  measurementId: index + 1, inputs: [variable([x])], outputs: [sample('out', [10 + x * 10])],
}))
const inverseRows = [[10, 2, 1], [20, 3, 2], [30, 8, 1]].map((values, index) => ({
  measurementId: index + 1,
  inputs: [sample('calculation:4', values.slice(0, 2), [2], { axes: [{ name: 't', ticks: [index, index + 1], unit: 's' }] }), sample('calculation:5', values.slice(2))],
  outputs: [variable([index])],
}))
const cases = [
  { name: 'forward-range-distance', options: { direction: 'forward', inputKeys: ['x'], outputKeys: ['out'], rows: scalarRows, inputScaling: 'range', k: 2, weighting: 'distance' }, query: [variable([.25])] },
  { name: 'forward-uniform', options: { direction: 'forward', inputKeys: ['x'], outputKeys: ['out'], rows: scalarRows, inputScaling: 'range', k: 2, weighting: 'uniform' }, query: [variable([.25])] },
  { name: 'inverse-block-weights', options: { direction: 'inverse', inputKeys: ['calculation:4', 'calculation:5'], outputKeys: ['x'], rows: inverseRows, inputScaling: 'standard-deviation', inputBlockWeights: { 'calculation:4': 2, 'calculation:5': .5 }, k: 2, weighting: 'distance' }, query: [sample('calculation:4', [18, 4], [2], { axes: [{ name: 't', ticks: [0, 1], unit: 's' }] }), sample('calculation:5', [1.8])] },
  { name: 'exact-ties-ignore-k', options: { direction: 'forward', inputKeys: ['x'], outputKeys: ['out'], rows: scalarRows.map(row => ({ ...row, inputs: [variable([1])] })), inputScaling: 'range', k: 1, weighting: 'distance' }, query: [variable([1])] },
  { name: 'modal-nearest-tie', options: { direction: 'forward', inputKeys: ['x'], outputKeys: ['out'], rows: [...scalarRows].reverse().map(row => ({ ...row, inputs: [variable([1])] })), inputScaling: 'range', k: 1, weighting: 'distance', nearestOnly: true }, query: [variable([1])] },
  { name: 'constant-inverse-clamp', options: { direction: 'inverse', inputKeys: ['calculation:4'], outputKeys: ['x'], rows: [1, 2, 9].map((x,index) => ({ measurementId:index+1, inputs:[sample('calculation:4',[1])],outputs:[variable([x])]})), inputScaling:'standard-deviation', k:1,weighting:'distance'},query:[sample('calculation:4',[2])] },
]
const dtypeValues = {
  int8: [[-129, -2, -1, 0, 126, 127], [-129, -3, -2, 1, 127, 128]],
  uint8: [[-2, 0, 1, 254, 255], [-1, 1, 2, 255, 256]],
  float32: [[.1, 1 + 2 ** -24, 16_777_217, -1e-45], [.1, 1 + 2 ** -24, 16_777_217, -1e-45]],
  float16: [[.1, 2 ** -25, 3 * 2 ** -25, 1 + 2 ** -11, 1 + 3 * 2 ** -11, -(2 ** -25), 65_519], [.1, 2 ** -25, 3 * 2 ** -25, 1 + 2 ** -11, 1 + 3 * 2 ** -11, -(2 ** -25), 65_519]],
  complex64: [[.1, -.1, 1 + 2 ** -24, -1 - 2 ** -24, 1e-45, -1e-45], [.1, -.1, 1 + 2 ** -24, -1 - 2 ** -24, 1e-45, -1e-45]],
}
const dtypeCases = Object.entries(dtypeValues).flatMap(([dtype, values]) =>
  (['forward', 'inverse'] as const).map((direction) => ({
    name: `dtype-${dtype}-${direction}`,
    options: { direction, inputKeys: ['x'], outputKeys: ['out', 'bounded'],
      inputScaling: direction === 'forward' ? 'range' : 'standard-deviation', k: 2, weighting: 'uniform',
      rows: values.map((output, index) => ({ measurementId: index + 1, inputs: [variable([index * 2])], outputs: [
        sample('out', output, [output.length / (dtype === 'complex64' ? 2 : 1)], { dtype }),
        sample('bounded', output, [output.length / (dtype === 'complex64' ? 2 : 1)], { dtype, minimum: -1.25, maximum: 1.25 }),
      ] })),
    }, query: [variable([1])],
  })),
)
const meaningCases = ['unit', 'quantityKind'].map((field) => ({
  name: `strict-calculation-${field}`,
  options: { direction: 'inverse', inputKeys: ['calculation:4'], outputKeys: ['x'], inputScaling: 'standard-deviation', k: 2, weighting: 'uniform',
    rows: [0, 1, 2].map((value) => ({ measurementId: value + 1,
      inputs: [sample('calculation:4', [value], [], { unit: 'K', quantityKind: 'thermodynamics.Temperature',
        ...(value === 2 ? { [field]: field === 'unit' ? 'Cel' : 'pressure.Pressure' } : {}) })], outputs: [variable([value])] })),
  }, query: [sample('calculation:4', [.5], [], { unit: 'K', quantityKind: 'thermodynamics.Temperature' })],
}))
const fixtures = [...cases, ...dtypeCases, ...meaningCases].map(item => {
  const options = { ...item.options, fingerprint: item.name }
  const model = buildPredictionKnnModel(options as Parameters<typeof buildPredictionKnnModel>[0])
  const result = predictWithKnn(model, item.query)
  return { ...item, expected: result, inputScales: Array.from(model.inputScales),
    includedMeasurementIds: model.cohort.includedMeasurementIds, excluded: model.cohort.excluded }
})
writeFileSync(process.argv[2], JSON.stringify({ contract: 'knn-v1/box-relative-v2', cases: fixtures }, null, 2) + '\n', 'utf8')
