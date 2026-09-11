import { convertUcumValue, type DataSchema, type RecordedData, type RecordedDataRule } from '@/lib/cad/model'
import { createDataTensorAccessor, isDataTensor } from '@/lib/cad/model/dataTensor'
import type { RecordedResultContracts } from '@/contracts/results'
import type { PolylineBundle } from '@/lib/cad/model/rayPaths'

export function parseResultPolylines(
  contracts: RecordedResultContracts,
  rules: readonly RecordedDataRule[],
  data?: RecordedData | null,
) {
  const bundles: PolylineBundle[] = []
  const errors: { label: string; message: string }[] = []
  for (const [label, contract] of Object.entries(contracts)) {
    const visual = contract.visualization
    if (visual.kind !== 'polyline' || !data) continue
    try {
      const read = (member: string | undefined) => {
        const name = `${label}.${member}`
        const rule = rules.find((candidate) => candidate.label === name)
        const value = data[name]
        if (!rule || !isDataTensor(value)) throw new Error(`${name}: recorded tensor is missing.`)
        return createDataTensorAccessor(rule.result as DataSchema, value, name)
      }
      const points = read(visual.vertices)
      const boundaries = read(visual.offsets)
      if (points.shape.length !== 2 || points.shape[1] !== 3 || boundaries.shape.length !== 1 || boundaries.size < 1)
        throw new Error('Polyline requires N×3 vertices and a one-dimensional offsets array.')
      const scale = convertUcumValue(
        1,
        rules.find((rule) => rule.label === `${label}.${visual.vertices}`)?.result.unit ?? 'm',
        'm',
        label,
      )
      const vertices = Float32Array.from({ length: points.size }, (_, i) => Number(points.at(i)) * scale)
      if (!vertices.every(Number.isFinite)) throw new Error('Polyline coordinates must be finite.')
      const rawOffsets = Array.from({ length: boundaries.size }, (_, i) => Number(boundaries.at(i)))
      if (
        rawOffsets[0] !== 0 ||
        rawOffsets[rawOffsets.length - 1] !== points.shape[0] ||
        rawOffsets.some(
          (offset, i) => !Number.isSafeInteger(offset) || offset < 0 || (i > 0 && offset - rawOffsets[i - 1] < 2),
        )
      )
        throw new Error('Polyline offsets must delimit paths with at least two vertices and end at the vertex count.')
      const pathCount = rawOffsets.length - 1
      const segmentCount = points.shape[0] - pathCount
      const attributes: Record<string, Float32Array> = {}
      for (const [name, attribute] of Object.entries(visual.attributes ?? {})) {
        const values = read(attribute.path)
        if (values.size !== (attribute.association === 'path' ? pathCount : segmentCount))
          throw new Error(`${name} does not match its ${attribute.association} count.`)
        const scale =
          name === 'wavelength'
            ? convertUcumValue(
                1,
                rules.find((rule) => rule.label === `${label}.${attribute.path}`)?.result.unit ?? 'm',
                'm',
                name,
              )
            : 1
        attributes[name] = Float32Array.from({ length: values.size }, (_, i) => Number(values.at(i)) * scale)
        if (!attributes[name].every(Number.isFinite)) throw new Error(`${name} must be finite.`)
      }
      bundles.push({
        id: label,
        pathCount,
        segmentCount,
        vertices,
        pathOffsets: Uint32Array.from(rawOffsets),
        segmentPower: attributes.power ?? new Float32Array(segmentCount).fill(1),
        pathWavelength: attributes.wavelength ?? new Float32Array(pathCount).fill(532e-9),
        segmentEvent: Uint8Array.from(attributes.event ?? new Float32Array(segmentCount)),
      })
    } catch (error) {
      errors.push({ label, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { bundles, errors }
}
