import { activeCatalogRuntimeSlice } from '../../catalog/runtime'
import { CadModelError } from '../model/errors'
import type { DefinedKernelTask, RecordedDataSpecNode, RecordedDataSpec } from './types'
import type { RecordedResultContract } from '@/contracts/results'
import type { KernelTaskConfig } from './kernelContract'

/** The common tet volume serialization, not a Solver-specific output declaration. */
function meshFieldSchema(values: RecordedDataSpec, lengthUnit: string): RecordedDataSpecNode {
  const integer = (name: string, length?: number) => ({
    dtype: 'int32' as const,
    axes: [{ name }, ...(length === undefined ? [] : [{ length }])],
  })
  const text = { dtype: 'string' as const }
  const strings = (name: string) => ({ ...text, axes: [{ name }] })
  return {
    values,
    location: text,
    quantity: text,
    valueUnit: text,
    domain: {
      kind: text,
      identity: text,
      lengthUnit: text,
      points: { dtype: 'float64', quantityKind: 'Length', unit: lengthUnit, axes: [{ name: 'node' }, { length: 3 }] },
      cells: { tet4: integer('cell', 4) },
      metadata: {
        boundaryFaces: integer('face', 3),
        cellRegions: integer('cell'),
        regionIds: strings('region'),
        supportNodes: integer('support'),
        loadPoints: {
          dtype: 'float64',
          quantityKind: 'Length',
          unit: lengthUnit,
          axes: [{ name: 'load' }, { length: 3 }],
        },
        loadVectors: {
          dtype: 'float64',
          quantityKind: 'mechanics.ForceMagnitude',
          unit: 'N',
          axes: [{ name: 'load' }, { length: 3 }],
        },
        quality: {
          cellVolumes: { dtype: 'float64', quantityKind: 'Volume', unit: `${lengthUnit}3`, axes: [{ name: 'cell' }] },
          meanRatios: { dtype: 'float64', quantityKind: 'Dimensionless', unit: '1', axes: [{ name: 'cell' }] },
        },
        boundaryProvenance: {
          offsets: integer('boundaryOffset'),
          sources: strings('alias'),
          rootIds: strings('alias'),
          sourceNodeIds: strings('alias'),
          surfaceIndices: integer('alias'),
        },
      },
    },
  } as RecordedDataSpecNode
}

export function resolveRecordedResult(
  node: RecordedDataSpecNode,
  tasks: Readonly<Record<string, DefinedKernelTask>>,
  path: string,
): RecordedResultContract {
  if (
    !node ||
    typeof node !== 'object' ||
    Array.isArray(node) ||
    !('task' in node) ||
    !('output' in node) ||
    typeof node.task !== 'string' ||
    typeof node.output !== 'string' ||
    Object.keys(node).length !== 2
  )
    throw new CadModelError(`${path} requires only { task, output }; manual recording schemas are no longer supported.`)
  const task = tasks[node.task]
  if (!task) throw new CadModelError(`${path} references unknown Task ${node.task}.`)
  const output = (task.config as KernelTaskConfig).outputs?.find((candidate) => candidate.key === node.output)
  if (!output) throw new CadModelError(`${path} references unknown output ${node.task}.${node.output}.`)
  const catalog = activeCatalogRuntimeSlice()
  const descriptor = catalog.solvers.find(
    (solver) => solver.name === task.kernel.name && solver.version === task.kernel.version,
  )?.descriptor
  const method = descriptor?.methods.outputs.find((candidate) => candidate.methodId === output.methodId)
  if (!method || !descriptor || !method.data.visualization)
    throw new CadModelError(`${path} output has no semantic Catalog contract.`)
  const { visualization, recording, ...data } = method.data
  let schema: RecordedDataSpecNode = 'resourceKind' in data ? data.members : (data as RecordedDataSpec)
  if (recording === 'mesh-field') schema = meshFieldSchema(data as RecordedDataSpec, descriptor.referenceLengthUnit)
  if (recording === 'structured-field') {
    const values = data as RecordedDataSpec
    schema = {
      values,
      location: { dtype: 'string' },
      quantity: { dtype: 'string' },
      valueUnit: { dtype: 'string' },
      domain: {
        kind: { dtype: 'string' },
        identity: { dtype: 'string' },
        lengthUnit: { dtype: 'string' },
        shape: { dtype: 'int64', axes: [{ name: 'dimension' }] },
        coordinates: Object.fromEntries(
          (values.axes ?? []).map((axis, index) => [
            `axis${index}`,
            {
              dtype: 'float64',
              quantityKind: 'Length',
              unit: descriptor.referenceLengthUnit,
              axes: [{ name: axis.name }],
            },
          ]),
        ),
      },
    } as RecordedDataSpecNode
  }
  return Object.freeze({
    task: node.task,
    output: node.output,
    solver: { ...task.kernel },
    artifactType: method.artifactType,
    catalogRevision: catalog.catalogRevision,
    visualization: structuredClone(visualization),
    schema: structuredClone(schema),
  })
}

export function resolveRecordedOutputReferences(
  node: RecordedDataSpecNode,
  tasks: Readonly<Record<string, DefinedKernelTask>>,
  path: string,
): RecordedDataSpecNode {
  return resolveRecordedResult(node, tasks, path).schema as RecordedDataSpecNode
}
