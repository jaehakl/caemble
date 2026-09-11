import type {
  RecordedData,
} from '@/lib/cad/model'
import type {
  RecordedDataSchemaTree,
  ResolvedDataSchema,
} from '@/lib/cad/simulation'
import type {
  MeasurementRecordedData,
  MeasurementRecordedDataLeaf,
  MeasurementRecordedDataNode,
} from '@/api'
import type { SavedRecordedData } from '@/features/cae-workbench/types'
import { recordedDataRules } from '@/lib/cad/simulation/recordedData'
export { experimentRecordContracts, flattenRecordedData, recordedDataRules } from '@/lib/cad/simulation/recordedData'

const namePattern = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u

function insertPath(root: Record<string, unknown>, path: string, value: unknown) {
  const names = path.split('.')
  if (names.some((name) => !namePattern.test(name))) throw new Error(`Stored RecordedData name is invalid: ${path}`)
  let group = root
  names.slice(0, -1).forEach((name) => {
    const current = group[name]
    if (current === undefined) group[name] = {}
    else if (!current || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error(`Stored RecordedData path collides with a tensor: ${path}`)
    }
    group = group[name] as Record<string, unknown>
  })
  const leaf = names[names.length - 1]
  if (group[leaf] !== undefined) throw new Error(`Stored RecordedData path is duplicated: ${path}`)
  group[leaf] = value
}

function freezeTree(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  Object.values(value).forEach((member) => {
    if (member && typeof member === 'object' && !Array.isArray(member) && !('dtype' in member) && !('shape' in member)) {
      freezeTree(member as Record<string, unknown>)
    }
  })
  return Object.freeze(value)
}

export function recordedDataSnapshot(rows: readonly SavedRecordedData[]) {
  const usableRows = rows.filter((row) => row.data !== null && row.data !== undefined)
  const data: Record<string, unknown> = {}
  const schemas: Record<string, unknown> = {}
  usableRows.forEach((row) => {
    const schema = row.data_schema ?? { dtype: row.dtype }
    insertPath(data, row.name, row.data)
    insertPath(schemas, row.name, {
      ...schema,
      dtype: row.dtype as ResolvedDataSchema['dtype'],
      tensorOrder: row.tensor_order,
      ...(row.quantity_kind ? { quantityKind: row.quantity_kind } : {}),
    } as ResolvedDataSchema)
  })
  const frozenData = freezeTree(data) as RecordedData
  const frozenSchemas = freezeTree(schemas) as RecordedDataSchemaTree
  return {
    data: frozenData,
    flatData: Object.freeze(Object.fromEntries(usableRows.map((row) => [row.name, row.data]))) as RecordedData,
    rules: recordedDataRules(frozenSchemas, 'measurement.recorded-data'),
    schemas: frozenSchemas,
  }
}

function isMeasurementRecordedDataLeaf(node: MeasurementRecordedDataNode): node is MeasurementRecordedDataLeaf {
  return (
    typeof node.experiment_record_id === 'number' &&
    (node.quantity_kind === null || typeof node.quantity_kind === 'string') &&
    typeof node.tensor_order === 'number' &&
    typeof node.dtype === 'string' &&
    Object.prototype.hasOwnProperty.call(node, 'data_schema') &&
    Object.prototype.hasOwnProperty.call(node, 'data')
  )
}

export function recordedDataTreeSnapshot(tree: MeasurementRecordedData, measurementId: number) {
  const rows: SavedRecordedData[] = []
  const visit = (node: MeasurementRecordedDataNode, path: string) => {
    if (isMeasurementRecordedDataLeaf(node)) {
      const leaf = node
      rows.push({
        measurement_id: measurementId,
        experiment_record_id: leaf.experiment_record_id,
        name: path,
        quantity_kind: leaf.quantity_kind,
        tensor_order: leaf.tensor_order,
        dtype: leaf.dtype,
        data_schema: leaf.data_schema,
        data: leaf.data,
        data_url: null,
        file_size: null,
      })
      return
    }
    Object.entries(node).forEach(([name, member]) => visit(member, `${path}.${name}`))
  }
  Object.entries(tree).forEach(([name, node]) => visit(node, name))
  return { ...recordedDataSnapshot(rows), rows: Object.freeze(rows) }
}
