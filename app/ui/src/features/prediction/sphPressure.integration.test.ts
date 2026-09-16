import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { expect, it } from 'vitest'
import type { BoxGridData, BoxGridProfile } from '@/contracts/boxGrid'
import { createDataTensor } from '@/lib/cad/model/dataTensor'
import type { RecordedDataRule } from '@/lib/cad/model/descriptor'
import { varsTensorFromFlat } from '@/lib/cad/model/tensor'
import { createCalculationInput } from '@/lib/calculation/input'
import { predictedRecordedData, predictionRecordedRowSample } from './data'
import { buildPredictionKnnModel, predictWithKnn } from './knn'

it('consumes Catalog SPH pressure and density through Calculation and Forward without a new result format', () => {
  const contracts = JSON.parse(
    execFileSync(
      'python',
      [
        '-X',
        'utf8',
        '-c',
        `
import json, sys
sys.path.insert(0, sys.argv[1])
from caemble_catalog import open_catalog
with open_catalog() as catalog:
    outputs = catalog.get_solver_manifest('sph', '1.1.0')['descriptor']['methods']['outputs']
    print(json.dumps({item['methodId']: item['data'] for item in outputs}))
`,
        path.resolve('../catalog'),
      ],
      { encoding: 'utf8' },
    ),
  ) as Record<string, RecordedDataRule['result'] & { boxGrid: BoxGridProfile; tensorOrder: number }>
  function record(name: 'pressure' | 'density', values: number[]) {
    const methodId = name === 'pressure' ? 'sph.pressure' : 'sph.mass-density'
    const result = contracts[methodId]
    const boxGrid: BoxGridData = {
      ...result.boxGrid,
      origin: [0, 0, 0],
      size: [3, 1, 1],
      gridShape: [3, 1, 1],
      rotation: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      lengthUnit: 'm',
      source: 'task',
      rootId: 'probe',
    }
    const rule = { label: name, methodId, target: [], parameters: {}, result } satisfies RecordedDataRule
    const tensor = createDataTensor(result, {
      value: varsTensorFromFlat(values, [3, 1, 1, 1, 1, 1, 1]),
      boxGrid,
      axes: [[0.5, 1.5, 2.5], [0.5], [0.5], [2], [0], ['value'], ['value']].map((ticks) => ({ ticks })),
    })
    const sample = predictionRecordedRowSample({
      name,
      measurement_id: 1,
      experiment_record_id: name === 'pressure' ? 1 : 2,
      dtype: 'float64',
      tensor_order: 0,
      quantity_kind: null,
      data_schema: result,
      data: tensor,
    })
    return { rule, tensor, sample, boxGrid }
  }
  const first = [record('pressure', [-20, 0, 0]), record('density', [8, 3, 0])]
  const second = [record('pressure', [-40, 0, 0]), record('density', [12, 3, 0])]
  const rules = first.map((item) => item.rule)
  const measured = createCalculationInput(rules, { pressure: first[0].tensor, density: first[1].tensor })
  expect(measured.pressure.quantityKind).toBe('Pressure')
  expect(measured.pressure.unit).toBe('Pa')
  expect(measured.density.unit).toBe('kg.m-3')
  expect(measured.pressure.data).toEqual([-20, 0, 0])
  expect(measured.pressure.boxGrid.configuration).toBe('current')
  expect(measured.pressure.boxGrid.weighting).toBe('material-volume')
  expect(measured.density.boxGrid.weighting).toBeUndefined()
  const scalar = (value: number) => ({ layout: { key: 'x', dtype: 'float64' as const, shape: [] }, values: [value] })
  const model = buildPredictionKnnModel({
    direction: 'forward',
    fingerprint: 'sph-pressure',
    inputKeys: ['x'],
    outputKeys: ['pressure', 'density'],
    k: 2,
    weighting: 'uniform',
    rows: [
      { measurementId: 1, inputs: [scalar(0)], outputs: first.map((item) => item.sample) },
      { measurementId: 2, inputs: [scalar(1)], outputs: second.map((item) => item.sample) },
    ],
  })
  const predicted = predictWithKnn(model, [scalar(0.5)], 'sph-pressure')
  const restored = predictedRecordedData(predicted.output, rules, undefined, {
    pressure: first[0].boxGrid,
    density: first[1].boxGrid,
  })
  const input = createCalculationInput(rules, restored)
  expect(input.pressure.data).toEqual([-30, 0, 0])
  expect(input.density.data).toEqual([10, 3, 0])
  expect(input.pressure.shape).toEqual([3, 1, 1, 1, 1, 1, 1])
  expect(input.pressure.boxGrid).toEqual(first[0].boxGrid)
  expect(input.pressure.axes).toEqual(input.density.axes)
  expect(input.density.data.map((value) => value > 0)).toEqual([true, true, false])
})
