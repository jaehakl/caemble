import { activeCatalogRuntimeSlice } from '../../catalog/runtime'
import { CadModelError } from '../model/errors'
import type { DefinedKernelTask, RecordedDataSpecNode, RecordedDataSpec } from './types'
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

export function resolveRecordedOutputReferences(
  node: RecordedDataSpecNode,
  tasks: Readonly<Record<string, DefinedKernelTask>>,
  path: string,
): RecordedDataSpecNode {
  if (!node || typeof node !== 'object' || Array.isArray(node))
    throw new CadModelError(`${path} must be a record declaration.`)
  if ('dtype' in node) return node
  if (typeof node.task === 'string' || typeof node.output === 'string') {
    if (typeof node.task !== 'string' || typeof node.output !== 'string' || Object.keys(node).length !== 2)
      throw new CadModelError(`${path} output reference requires only task and output.`)
    const task = tasks[node.task]
    if (!task) throw new CadModelError(`${path} references unknown Task ${node.task}.`)
    const output = (task.config as KernelTaskConfig).outputs?.find((candidate) => candidate.key === node.output)
    if (!output) throw new CadModelError(`${path} references unknown output ${node.task}.${node.output}.`)
    const descriptor = activeCatalogRuntimeSlice().solvers.find(
      (solver) => solver.name === task.kernel.name && solver.version === task.kernel.version,
    )?.descriptor
    const method = descriptor?.methods.outputs.find((candidate) => candidate.methodId === output.methodId)
    if (!method || !descriptor) throw new CadModelError(`${path} output has no Catalog contract.`)
    if ('resourceKind' in method.data) return method.data.members as RecordedDataSpecNode
    const values = method.data as RecordedDataSpec
    return ['node', 'cell'].includes(values.axes?.[0]?.name ?? '')
      ? meshFieldSchema(values, descriptor.referenceLengthUnit)
      : values
  }
  return Object.fromEntries(
    Object.entries(node).map(([name, child]) => [
      name,
      resolveRecordedOutputReferences(child, tasks, `${path}.${name}`),
    ]),
  )
}
