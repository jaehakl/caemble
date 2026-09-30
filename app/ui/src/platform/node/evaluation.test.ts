// @vitest-environment node
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { calculationExampleInput, calculationExamples } from '@/authoring/examples'
import { createDataTensor } from '@/lib/cad/model/dataTensor'
import type { DataSchemaAxis } from '@/lib/cad/model/descriptor'
import { varsTensorFromFlat } from '@/lib/cad/model/tensor'
import { prepareRecordedCalculationInput } from '@/lib/calculation/recordedInput'
import { analyzeCalculationSource } from '@/lib/calculation/sourcePolicy'
import { transformCalculationSource } from '@/lib/calculation/transform'
import { executeCalculation } from '@/lib/calculation/execute'
import { evaluateRequest } from './evaluation'

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
