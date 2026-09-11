// @vitest-environment node
import { expect, it } from 'vitest'
import type { RecordedResultContracts } from '@/contracts/results'
import type { RecordedDataRule } from '@/lib/cad/model'
import { createDataTensor } from '@/lib/cad/model/dataTensor'
import { parseResultPolylines } from './resultPolylines'
import { parseRecordedMeshFields } from './meshFields'

const contract = {
  task: 'anyTask',
  output: 'anyOutput',
  solver: { name: 'fixture', version: '1.0.0' },
  artifactType: 'fixture@1',
  catalogRevision: 'frozen',
  schema: {},
  visualization: {
    kind: 'polyline' as const,
    coordinateSpace: 'experiment' as const,
    vertices: 'positions',
    offsets: 'boundaries',
  },
}
const contracts: RecordedResultContracts = { light: contract, another: contract }
const rules: RecordedDataRule[] = Object.keys(contracts).flatMap((name) => [
  {
    label: `${name}.positions`,
    methodId: 'fixture',
    parameters: {},
    target: [],
    result: { dtype: 'float32' as const, quantityKind: 'Length', unit: 'mm', axes: [{ length: 2 }, { length: 3 }] },
  },
  {
    label: `${name}.boundaries`,
    methodId: 'fixture',
    parameters: {},
    target: [],
    result: { dtype: 'uint32' as const, axes: [{ length: 2 }] },
  },
])
const data = Object.fromEntries(
  rules.map((rule) => [
    rule.label,
    createDataTensor(rule.result, {
      value: rule.label.endsWith('positions')
        ? [
            [0, 0, 0],
            [1000, 0, 0],
          ]
        : [0, 2],
    }),
  ]),
)

it('uses semantic bindings and units for multiple arbitrary result and member names', () => {
  const result = parseResultPolylines(contracts, rules, data)
  expect(result.errors).toEqual([])
  expect(result.bundles.map((bundle) => bundle.id)).toEqual(['light', 'another'])
  expect(result.bundles[0].vertices[3]).toBe(1)
  expect(parseResultPolylines({}, rules, data).bundles).toEqual([])
  expect(parseRecordedMeshFields(rules, data, contracts).fields).toEqual([])
})

it('isolates a corrupt polyline from another valid result', () => {
  const result = parseResultPolylines(contracts, rules, {
    ...data,
    'light.boundaries': createDataTensor({ dtype: 'uint32' }, { value: [0, 3] }),
  })
  expect(result.errors[0].label).toBe('light')
  expect(result.bundles.map((bundle) => bundle.id)).toEqual(['another'])
})
