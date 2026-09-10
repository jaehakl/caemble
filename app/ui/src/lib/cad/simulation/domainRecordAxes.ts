import type { DataTensor } from '../model/descriptor'

const ordinalNames = new Set([
  'node',
  'cell',
  'face',
  'region',
  'support',
  'load',
  'boundaryOffset',
  'alias',
  'coordinate',
  'localNode',
  'component',
])

/** Read compatibility for domain records written before mesh axes were retained. */
export function restoreDomainRecordAxes(
  tensor: DataTensor,
  schema: Readonly<Record<string, unknown>> | null | undefined,
  tensorOrder: number,
  meshMember: boolean,
): DataTensor {
  if (!meshMember || tensor.axes?.length || !Array.isArray(schema?.axes)) return tensor
  const axes = schema.axes as readonly Readonly<{
    name?: string
    length?: number
    unit?: string
    quantityKind?: string
    ticks?: readonly (number | string)[]
  }>[]
  if (axes.length !== tensor.shape.length - tensorOrder || !axes.length) return tensor
  if (
    !axes.every(
      (axis, index) =>
        !axis.unit &&
        !axis.quantityKind &&
        (axis.length === undefined || axis.length === tensor.shape[index]) &&
        (ordinalNames.has(axis.name ?? '') || (!axis.name && axis.length !== undefined)),
    )
  )
    return tensor
  return { ...tensor, axes: axes.map((axis) => (axis.ticks ? { ticks: axis.ticks } : { implicitOrdinal: true })) }
}
