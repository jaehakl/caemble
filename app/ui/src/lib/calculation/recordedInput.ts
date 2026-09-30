import type {
  MeasurementRecordedData,
  MeasurementRecordedDataNode,
  MeasurementRecordedDataLeaf,
} from '@/contracts/api/measurement'
import type { RecordedDataRule, RecordedDataTensor } from '@/lib/cad/model/descriptor'
import { createCalculationInput } from './input'
import { analyzeCalculationDependencies } from './dependencies'

/** Shared by browser/API adapters and the credential-free Node evaluator. */
export function prepareRecordedCalculationInput(tree: MeasurementRecordedData, source: string) {
  const leaves = new Map<string, MeasurementRecordedDataLeaf>()
  const visit = (node: MeasurementRecordedDataNode, prefix: string) => {
    if (typeof node.experiment_record_id === 'number') {
      leaves.set(prefix, node as MeasurementRecordedDataLeaf)
      return
    }
    for (const [name, child] of Object.entries(node))
      visit(child as MeasurementRecordedDataNode, prefix ? `${prefix}.${name}` : name)
  }
  visit(tree, '')
  const dependencies = analyzeCalculationDependencies(source, [...leaves.keys()])
  const rules: RecordedDataRule[] = dependencies.map((label) => {
    const leaf = leaves.get(label)!
    return {
      label,
      target: [],
      methodId: 'recorded-data',
      parameters: {},
      result: {
        ...leaf.data_schema,
        dtype: leaf.dtype,
        tensorOrder: leaf.tensor_order,
        ...(leaf.quantity_kind ? { quantityKind: leaf.quantity_kind } : {}),
      },
    } as RecordedDataRule
  })
  const flat = Object.fromEntries(dependencies.map((name) => [name, leaves.get(name)!.data])) as Record<
    string,
    RecordedDataTensor
  >
  return {
    input: createCalculationInput(rules, flat),
    dependencies,
    experimentRecordIds: dependencies.map((name) => leaves.get(name)!.experiment_record_id),
    recordContracts: dependencies.map((name) => {
      const { data: _data, ...contract } = leaves.get(name)!
      void _data
      return { name, ...contract }
    }),
  }
}
