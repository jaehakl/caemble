import { getQuantityKindTensorOrder } from '../../quantitykind/runtime'
import { CadModelError } from '../model/errors'
import type {
  DefinedKernelTask,
  KernelIdentity,
  RecordedDataSchemaTree,
  RecordedDataSpec,
  RecordedDataSpecNode,
  ResolvedDataSchema,
  ResolvedDataSchemaNode,
  SimulationProgramManifest,
} from './types'

export function defineTask<Config>(kernel: KernelIdentity, config: NoInfer<Config>): DefinedKernelTask<Config> {
  return Object.freeze({ kind: 'caemble-kernel-task' as const, kernel: Object.freeze({ ...kernel }), config })
}

function canonicalValue(value: unknown, path: string) {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new TypeError('value is not JSON-serializable')
    return JSON.parse(serialized) as unknown
  } catch (error) {
    throw new CadModelError(`${path} must contain JSON-serializable values: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function canonicalRecordedDataSpec(spec: RecordedDataSpec, path = 'RecordedData'): ResolvedDataSchema {
  if (spec.axes !== undefined && !Array.isArray(spec.axes)) {
    throw new CadModelError(`${path}.axes must be an array.`)
  }
  return Object.freeze({
    ...spec,
    tensorOrder: spec.quantityKind ? getQuantityKindTensorOrder(spec.quantityKind) : 0,
    ...(spec.axes === undefined
      ? {}
      : { axes: Object.freeze(spec.axes.map((axis) => Object.freeze({ ...axis }))) }),
  }) as ResolvedDataSchema
}

function canonicalRecordedDataNode(node: RecordedDataSpecNode, path: string): ResolvedDataSchemaNode {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    throw new CadModelError(`${path} must be a tensor descriptor or group.`)
  }
  if ('dtype' in node) return canonicalRecordedDataSpec(node as RecordedDataSpec, path)
  if (['tensorOrder', 'axes', 'unit', 'quantityKind', 'basis'].some((key) => key in node)) {
    throw new CadModelError(`${path} must not mix RecordedData descriptor fields with group members.`)
  }
  return Object.freeze(
    Object.fromEntries(Object.entries(node).map(([name, member]) => [name, canonicalRecordedDataNode(member, `${path}.${name}`)])),
  )
}

export function canonicalRecordedDataTree(
  recordedData: Readonly<Record<string, RecordedDataSpecNode>>,
): RecordedDataSchemaTree {
  if (typeof recordedData !== 'object' || recordedData === null || Array.isArray(recordedData)) {
    throw new CadModelError('recordedData must be an object.')
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(recordedData).map(([name, node]) => [name, canonicalRecordedDataNode(node, `recordedData.${name}`)]),
    ),
  )
}

function buildSimulationProgramManifest(
  tasks: Readonly<Record<string, DefinedKernelTask>>,
  recordedData: RecordedDataSchemaTree,
  pythonSource: string,
): SimulationProgramManifest {
  return Object.freeze({
    pythonSource,
    tasks: Object.freeze(
      Object.fromEntries(
        Object.entries(tasks).map(([name, task]) => [
          name,
          Object.freeze({
            kernel: Object.freeze({ ...task.kernel }),
            config: canonicalValue(task.config, `Task ${JSON.stringify(name)} config`),
          }),
        ]),
      ),
    ),
    recordedData,
  })
}

export function simulationProgramManifest(
  tasks: Readonly<Record<string, DefinedKernelTask>>,
  recordedData: Readonly<Record<string, RecordedDataSpecNode>>,
  pythonSource: string,
): SimulationProgramManifest {
  return buildSimulationProgramManifest(tasks, canonicalRecordedDataTree(recordedData), pythonSource)
}

export function simulationProgramManifestFromResolved(
  tasks: Readonly<Record<string, DefinedKernelTask>>,
  recordedData: RecordedDataSchemaTree,
  pythonSource: string,
): SimulationProgramManifest {
  return buildSimulationProgramManifest(tasks, recordedData, pythonSource)
}
