// @vitest-environment node
import { createHash } from 'node:crypto'
import path from 'node:path'
import { expect, it } from 'vitest'
import { readCatalogExamples } from '../../../scripts/catalog-example-support'
import { calculationExampleInput, calculationExamples } from '@/authoring/examples'
import { createDataTensor } from '@caemble/execution/cad/model/dataTensor'
import type { DataSchemaAxis } from '@caemble/execution/cad/model/descriptor'
import { varsTensorFromFlat } from '@caemble/execution/cad/model/tensor'
import { prepareRecordedCalculationInput } from '@caemble/execution/calculation/recordedInput'
import {
  preparePredictedCalculationInput,
  type PredictedCalculationArtifact,
} from '@caemble/execution/calculation/predictedInput'
import type { RecordedDataRule } from '@caemble/execution/cad/model/descriptor'
import { analyzeCalculationSource } from '@caemble/execution/calculation/sourcePolicy'
import { transformCalculationSource } from '@caemble/execution/calculation/transform'
import { executeCalculation } from '@caemble/execution/calculation/execute'
import { evaluateRequest } from '@caemble/execution/node/evaluation'

const signal = calculationExampleInput.signal
const schema = {
  dtype: signal.dtype,
  quantityKind: 'Dimensionless',
  unit: '1',
  axes: signal.axes.map((axis): DataSchemaAxis =>
    axis.unit
      ? {
          name: axis.name,
          ticks: axis.ticks,
          unit: axis.unit,
          quantityKind: axis.name === 'time' ? 'Time' : axis.name === 'frequency' ? 'Frequency' : 'Length',
        }
      : { name: axis.name, ticks: axis.ticks },
  ),
  boxGrid: signal.boxGrid,
}
const tree = {
  signal: {
    experiment_record_id: 9,
    quantity_kind: 'Dimensionless',
    tensor_order: 0,
    dtype: 'float64',
    data_schema: schema,
    data: createDataTensor(schema, {
      value: varsTensorFromFlat(signal.data, signal.shape),
      boxGrid: signal.boxGrid,
      axes: signal.axes.map(({ ticks }) => ({ ticks })),
    }),
  },
}

it('matches the browser Calculation executor for real Box Grid RecordedData', async () => {
  const source = calculationExamples[0].source
  const source_hash = createHash('sha256').update(source).digest('hex')
  const prepared = prepareRecordedCalculationInput(tree, source)
  expect(prepared.input.signal).toEqual({ ...signal, quantityKind: 'Dimensionless', unit: '1' })
  const browser = executeCalculation(
    transformCalculationSource(source, source_hash, analyzeCalculationSource(source)),
    prepared.input,
    () => {},
  )
  const result = await evaluateRequest(
    {
      stage: 'calculate',
      measurement_id: 12,
      recorded_data: tree,
      calculations: [{ key: 'objective', source, source_hash }],
    },
    '',
  )
  expect(result).toMatchObject({
    measurement_id: 12,
    calculations: [{ key: 'objective', source_hash, value: 5, output: browser }],
  })
})

it.each([
  ['return { dtype: "float64", data: [1, 2] }', 'finite scalar'],
  ['return { dtype: "float64", data: 1 / 0 }', 'finite'],
  ['return { dtype: "float64", data: input.missing.data[0] }', 'missing'],
])('rejects unusable objective: %s', async (body, message) => {
  const source = `export default function calculate(input) { ${body} }`
  const source_hash = createHash('sha256').update(source).digest('hex')
  await expect(
    evaluateRequest(
      {
        stage: 'calculate',
        measurement_id: 12,
        recorded_data: tree,
        calculations: [{ key: 'objective', source, source_hash }],
      },
      '',
    ),
  ).rejects.toThrow(new RegExp(message, 'i'))
})

const prediction: PredictedCalculationArtifact = {
  output: [
    {
      layout: { key: 'signal', dtype: signal.dtype, shape: signal.shape, axes: signal.axes, boxGrid: signal.boxGrid },
      values: signal.data,
    },
  ],
  rules: [
    {
      label: 'signal',
      target: [],
      methodId: 'fixture',
      parameters: {},
      result: { ...schema, tensorOrder: 0 },
    } as RecordedDataRule,
  ],
  candidate_box_grids: { signal: signal.boxGrid },
}

it('calculates equal actual and predicted BoxGrid values without creating a Measurement', async () => {
  const source = calculationExamples[0].source
  const source_hash = createHash('sha256').update(source).digest('hex')
  expect(preparePredictedCalculationInput(prediction, source).input).toEqual(
    prepareRecordedCalculationInput(tree, source).input,
  )
  const calculated = await evaluateRequest(
    { stage: 'calculate_prediction', prediction, calculations: [{ key: 'objective', source, source_hash }] },
    '',
  )
  expect(calculated).toMatchObject({ calculations: [{ key: 'objective', value: 5, source_hash }] })
  expect(calculated).not.toHaveProperty('measurement_id')
})

it('restores Candidate position, extent and rotation with relative cell coordinates', () => {
  const grid = {
    ...signal.boxGrid,
    origin: [10, 20, 30] as const,
    size: [4, 6, 8] as const,
    rotation: [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ] as const,
  }
  const restored = preparePredictedCalculationInput(
    { ...prediction, candidate_box_grids: { signal: grid } },
    calculationExamples[0].source,
  )
  expect(restored.input.signal.boxGrid).toEqual(grid)
  expect(restored.input.signal.axes.slice(0, 3).map((axis) => axis.ticks)).toEqual(
    grid.gridShape.map((count, axis) =>
      Array.from({ length: count }, (_, cell) => ((cell + 0.5) * grid.size[axis]) / count),
    ),
  )
  expect(restored.input.signal.data).toEqual(signal.data)
})

it.each(['calculate', 'calculate_prediction'] as const)(
  'rejects a changed Calculation source before %s',
  async (stage) => {
    const calculations = [{ key: 'objective', source: calculationExamples[0].source, source_hash: '0'.repeat(64) }]
    const request =
      stage === 'calculate'
        ? { stage, measurement_id: 12, recorded_data: tree, calculations }
        : { stage, prediction, calculations }
    await expect(evaluateRequest(request, '')).rejects.toThrow('source hash')
  },
)

it('prepares Candidate records without a Solver build or a Measurement', async () => {
  const { examples, catalog } = readCatalogExamples(
    path.resolve('../../shared/catalog/caemble_catalog/catalog.sqlite3'),
  )
  const example = examples.find((item) => item.key === 'hybrid-box-conductor')!
  expect(example).toBeDefined()
  const request = {
    stage: 'predict_prepare' as const,
    build: {
      source_bundle: example.sourceBundle,
      source_hash: example.bundleHash,
      catalog,
      mode: 'candidate' as const,
      vars: { length: 5.5, width: 0.9 },
    },
    record_names: ['totalCurrent'],
  }
  const candidate = await evaluateRequest(request, path.resolve('../../shared/execution/src/cad/api'))
  expect(candidate).toMatchObject({
    vars: request.build.vars,
    rules: [{ label: 'totalCurrent' }],
    candidate_box_grids: {
      totalCurrent: {
        size: [expect.closeTo(0.0055), expect.closeTo(0.0009), expect.closeTo(0.0005)],
        gridShape: [1, 1, 1],
      },
    },
  })
  expect(candidate).not.toHaveProperty('measurement')
}, 30_000)
