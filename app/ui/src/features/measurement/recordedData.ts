import type {
  RecordedData,
  RecordedDataGroup,
  RecordedDataNode,
  RecordedDataRule,
} from '@/lib/cad/model'
import type {
  RecordedDataSchemaTree,
  ResolvedDataSchema,
  ResolvedDataSchemaNode,
} from '@/lib/cad/simulation'
import { persistDataSchema } from '@/lib/cad/model'
import type {
  ExperimentRecordContract,
  MeasurementRecordedData,
  MeasurementRecordedDataLeaf,
  MeasurementRecordedDataNode,
} from '@/api'
import type { SavedRecordedData } from '@/features/cae-workbench/types'

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

function schemaLeaf(value: ResolvedDataSchemaNode): value is ResolvedDataSchema {
  return 'dtype' in value
}

export function experimentRecordContracts(schemas: RecordedDataSchemaTree): readonly ExperimentRecordContract[] {
  const records: ExperimentRecordContract[] = []
  const visit = (node: ResolvedDataSchemaNode, path: string) => {
    if (schemaLeaf(node)) {
      const { tensorOrder, ...dataSchema } = node
      records.push({
        name: path,
        quantity_kind: node.quantityKind ?? null,
        tensor_order: tensorOrder,
        dtype: node.dtype,
        data_schema: persistDataSchema(dataSchema),
      })
      return
    }
    Object.entries(node).forEach(([name, member]) => visit(member, `${path}.${name}`))
  }
  Object.entries(schemas).forEach(([name, node]) => visit(node, name))
  return Object.freeze(records)
}

export function recordedDataRules(schemas: RecordedDataSchemaTree, methodId: string): readonly RecordedDataRule[] {
  const rules: RecordedDataRule[] = []
  const visit = (node: ResolvedDataSchemaNode, path: string) => {
    if (schemaLeaf(node)) {
      rules.push(
        Object.freeze({
          target: Object.freeze([]),
          label: path,
          methodId,
          parameters: Object.freeze({}),
          result: node,
        }),
      )
      return
    }
    Object.entries(node).forEach(([name, member]) => visit(member, `${path}.${name}`))
  }
  Object.entries(schemas).forEach(([name, node]) => visit(node, name))
  return Object.freeze(rules)
}

export function flattenRecordedData(
  schemas: RecordedDataSchemaTree,
  recordedData: RecordedData | null | undefined,
): RecordedData | null | undefined {
  if (!recordedData) return recordedData
  const flat: Record<string, RecordedDataNode> = {}
  const visit = (schema: ResolvedDataSchemaNode, value: RecordedDataNode, path: string) => {
    if (schemaLeaf(schema)) {
      flat[path] = value
      return
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be a group.`)
    const group = value as RecordedDataGroup
    Object.entries(schema).forEach(([name, member]) => visit(member, group[name], `${path}.${name}`))
  }
  Object.entries(schemas).forEach(([name, schema]) => {
    const value = recordedData[name]
    if (value !== undefined) visit(schema, value, name)
  })
  return Object.freeze(flat)
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
