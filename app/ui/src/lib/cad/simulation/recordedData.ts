import type { RecordedData, RecordedDataGroup, RecordedDataNode, RecordedDataRule } from '../model/descriptor'
import { persistDataSchema } from '../model/dataTensor'
import type { ExperimentRecordContract } from '@/contracts/api/experiment'
import type { RecordedDataSchemaTree, ResolvedDataSchema, ResolvedDataSchemaNode } from './types'

export function experimentRecordContracts(schemas: RecordedDataSchemaTree): readonly ExperimentRecordContract[] {
  const records: ExperimentRecordContract[] = []
  const visit = (node: ResolvedDataSchemaNode, path: string) => {
    if ('dtype' in node) {
      const { tensorOrder, ...dataSchema } = node as ResolvedDataSchema
      records.push({
        name: path,
        quantity_kind: dataSchema.quantityKind ?? null,
        tensor_order: tensorOrder,
        dtype: dataSchema.dtype,
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
    if ('dtype' in node) {
      rules.push(
        Object.freeze({
          target: Object.freeze([]),
          label: path,
          methodId,
          parameters: Object.freeze({}),
          result: node as ResolvedDataSchema,
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
    if ('dtype' in schema) {
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
