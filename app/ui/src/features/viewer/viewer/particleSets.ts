import type { RecordedResultContracts } from '@/contracts/results'
import { convertUcumValue, type RecordedData, type RecordedDataRule, type UcumUnit } from '@/lib/cad/model'
import { createDataTensorAccessor, isDataTensor } from '@/lib/cad/model/dataTensor'
import { meshMaterialColors, type MeshRenderData, type MeshRenderGeometry } from './meshFields'
import { plotColor } from './pointCloudData'

export type ParticleQuantity = Readonly<{
  quantityKind: string
  unit: UcumUnit
  components: readonly string[]
  values: Float64Array
  rowConfiguration?: 'current'
  columnConfiguration?: 'reference'
}>

export type RecordedParticleSet = Readonly<{
  label: string
  identity: string
  lengthUnit: UcumUnit
  particleIds: readonly number[]
  materialIndices: Int32Array
  materialNames: readonly string[]
  times: Float64Array
  positions: Float64Array
  attributes: Readonly<Record<string, ParticleQuantity>>
  radius?: string
  configuration?: 'reference' | 'current'
}>

/** Particle identities and physical meanings come from the frozen semantic contract. */
export function parseRecordedParticleSets(
  rules: readonly RecordedDataRule[],
  data?: RecordedData | null,
  contracts: RecordedResultContracts = {},
) {
  const particles: RecordedParticleSet[] = []
  const errors: { label: string; message: string }[] = []
  const byLabel = new Map(rules.map((rule) => [rule.label, rule.result]))
  for (const [label, contract] of Object.entries(contracts)) {
    if (contract.visualization.kind !== 'particle-set' || !data) continue
    try {
      const semantic = contract.visualization.particleSet
      if (!semantic || contract.visualization.coordinateSpace !== 'experiment')
        throw new Error('Particles require explicit paths in experiment coordinates.')
      const read = (member: string) => {
        const path = `${label}.${member}`
        const schema = byLabel.get(path)
        const value = data[path]
        if (!schema || !isDataTensor(value)) throw new Error(`Particle visualization is missing ${member}.`)
        return { schema, accessor: createDataTensorAccessor(schema, value, path) }
      }
      const numeric = (member: string, shape: readonly number[], unit?: UcumUnit) => {
        const { schema, accessor } = read(member)
        if (
          accessor.shape.length !== shape.length ||
          shape.some((size, axis) => size >= 0 && size !== accessor.shape[axis])
        )
          throw new Error(`Particle ${member} has an inconsistent shape.`)
        const scale = unit ? convertUcumValue(1, schema.unit as UcumUnit, unit, member) : 1
        return Float64Array.from({ length: accessor.size }, (_, index) => {
          const value = accessor.at(index)
          if (typeof value !== 'number' || !Number.isFinite(value * scale))
            throw new Error(`Particle ${member} must contain finite real values.`)
          return value * scale
        })
      }
      const particleIds = Array.from(numeric(semantic.particleIds, [-1]))
      if (
        !particleIds.length ||
        particleIds.some((id) => !Number.isSafeInteger(id) || id < 0) ||
        new Set(particleIds).size !== particleIds.length
      )
        throw new Error('Particle IDs must be distinct nonnegative safe integers.')
      const times = numeric(semantic.times, [-1], 's')
      if (!times.length || times.some((time, index) => index > 0 && time <= times[index - 1]))
        throw new Error('Particle times must be nonempty and strictly increasing.')
      const materialTensor = read(semantic.materialNames).accessor
      if (materialTensor.shape.length !== 1 || !materialTensor.size)
        throw new Error('Particle materials must be a nonempty table.')
      const materialNames = Array.from({ length: materialTensor.size }, (_, index) => {
        const value = materialTensor.at(index)
        if (typeof value !== 'string' || !value) throw new Error('Particle materials must have names.')
        return value
      })
      const materialIndices = numeric(semantic.materialIndices, [particleIds.length])
      if (materialIndices.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= materialNames.length))
        throw new Error('Particle material indices must reference the material table.')
      const lengthUnit = read(semantic.positions).schema.unit as UcumUnit
      convertUcumValue(1, lengthUnit, 'm', 'Particle positions')
      const positions = numeric(semantic.positions, [times.length, particleIds.length, 3], lengthUnit)
      const attributes: Record<string, ParticleQuantity> = {}
      for (const [name, attribute] of Object.entries(semantic.attributes)) {
        const { schema, accessor } = read(attribute.path)
        if (!schema.quantityKind || !schema.unit) throw new Error(`Particle ${name} requires a QuantityKind and unit.`)
        const components = attribute.components ?? []
        if (new Set(components).size !== components.length)
          throw new Error(`Particle ${name} has duplicate components.`)
        const componentTicks = accessor.tensor.axes?.[2]?.ticks
        if (
          components.length &&
          (!componentTicks ||
            componentTicks.length !== components.length ||
            componentTicks.some((tick, index) => tick !== components[index]))
        )
          throw new Error(`Particle ${name} coordinates differ from the declared components.`)
        const values = numeric(attribute.path, [
          times.length,
          particleIds.length,
          ...(components.length ? [components.length] : []),
        ])
        attributes[name] = {
          quantityKind: schema.quantityKind,
          unit: schema.unit,
          components,
          values,
          rowConfiguration: attribute.rowConfiguration,
          columnConfiguration: attribute.columnConfiguration,
        }
      }
      // Values are addressed by explicit particle/time coordinates, never by an assumed permanent row index.
      for (const member of [
        semantic.positions,
        ...Object.values(semantic.attributes).map((attribute) => attribute.path),
      ]) {
        const { schema, accessor } = read(member)
        const ids = accessor.tensor.axes?.[1]?.ticks
        const stamps = accessor.tensor.axes?.[0]?.ticks
        const timeScale = convertUcumValue(1, schema.axes?.[0]?.unit as UcumUnit, 's', `${member} time`)
        if (!ids || ids.length !== particleIds.length || ids.some((id, index) => id !== particleIds[index]))
          throw new Error(`Particle ${member} coordinates differ from the declared IDs.`)
        if (
          !stamps ||
          stamps.length !== times.length ||
          stamps.some((time, index) => Number(time) * timeScale !== times[index])
        )
          throw new Error(`Particle ${member} coordinates differ from the timeline.`)
      }
      let radius: string | undefined
      if (semantic.radius) {
        radius = Object.keys(semantic.attributes).find((name) => semantic.attributes[name].path === semantic.radius)
        const quantity = radius ? attributes[radius] : undefined
        if (!quantity || quantity.components.length || quantity.values.some((value) => value <= 0))
          throw new Error('Physical particle radii must be positive scalar quantities.')
        convertUcumValue(1, quantity.unit, lengthUnit, 'Particle radius')
      }
      particles.push({
        label,
        identity: `${label}:${JSON.stringify(particleIds)}`,
        lengthUnit,
        particleIds,
        materialIndices: Int32Array.from(materialIndices),
        materialNames,
        times,
        positions,
        attributes,
        radius,
        configuration: contract.visualization.configuration,
      })
    } catch (error) {
      errors.push({ label, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { particles, errors }
}

export function particleFrameValues(
  particles: RecordedParticleSet,
  attribute: string,
  component: number | 'magnitude',
  frame: number,
) {
  const quantity = particles.attributes[attribute]
  const count = particles.particleIds.length
  const width = quantity.components.length || 1
  return Float64Array.from({ length: count }, (_, particle) => {
    const offset = (frame * count + particle) * width
    return component === 'magnitude'
      ? Math.hypot(...quantity.values.subarray(offset, offset + width))
      : quantity.values[offset + component]
  })
}

const sphereVertices: number[][] = []
const sphereTriangles: number[] = []
for (let latitude = 0; latitude <= 8; latitude++) {
  for (let longitude = 0; longitude <= 12; longitude++) {
    const theta = (latitude * Math.PI) / 8
    const phi = (longitude * Math.PI) / 6
    sphereVertices.push([Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)])
    if (latitude < 8 && longitude < 12) {
      const a = latitude * 13 + longitude
      sphereTriangles.push(a, a + 13, a + 1, a + 1, a + 13, a + 14)
    }
  }
}

/** DEM spheres retain physical radii; continuum points use only a screen-space size. */
export function createParticleRenderData(
  particles: RecordedParticleSet,
  frame: number,
  displayUnit: UcumUnit,
  values?: Float64Array,
  pointSize = 5,
): MeshRenderData {
  const count = particles.particleIds.length
  const scale = convertUcumValue(1, particles.lengthUnit, displayUnit, 'Particle display length')
  const radius = particles.radius ? particles.attributes[particles.radius] : undefined
  const radiusScale = radius ? convertUcumValue(1, radius.unit, displayUnit, 'Particle display radius') : 0
  const range = values?.reduce(
    ([minimum, maximum], value) => [Math.min(minimum, value), Math.max(maximum, value)],
    [Infinity, -Infinity],
  )
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
  const geometries: MeshRenderGeometry[] = []
  const verticesPerParticle = radius ? sphereVertices.length : 1
  const chunkSize = Math.floor(60_000 / verticesPerParticle)
  for (let start = 0; start < count; start += chunkSize) {
    const length = Math.min(chunkSize, count - start)
    const positions = new Float32Array(length * verticesPerParticle * 3)
    const colors = new Float32Array(length * verticesPerParticle * 4)
    const indices = new Uint16Array(length * (radius ? sphereTriangles.length : 1))
    for (let local = 0; local < length; local++) {
      const index = start + local
      const offset = (frame * count + index) * 3
      const center = Array.from(particles.positions.subarray(offset, offset + 3), (value) => value * scale)
      const size = radius ? radius.values[frame * count + index] * radiusScale : 0
      const hex = meshMaterialColors[particles.materialIndices[index] % meshMaterialColors.length]
      const color =
        values && range
          ? plotColor(values[index], range)
          : [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).concat(1)
      for (let axis = 0; axis < 3; axis++) {
        bounds.min[axis] = Math.min(bounds.min[axis], center[axis] - size)
        bounds.max[axis] = Math.max(bounds.max[axis], center[axis] + size)
      }
      for (let vertex = 0; vertex < verticesPerParticle; vertex++) {
        const normal = radius ? sphereVertices[vertex] : [0, 0, 0]
        const shade = radius ? 0.35 + 0.65 * Math.abs(normal[0] * 0.267 + normal[1] * 0.535 + normal[2] * 0.802) : 1
        const row = local * verticesPerParticle + vertex
        for (let axis = 0; axis < 3; axis++) positions[row * 3 + axis] = center[axis] + size * normal[axis]
        for (let channel = 0; channel < 4; channel++)
          colors[row * 4 + channel] = color[channel] * (channel === 3 ? 1 : shade)
      }
      if (radius)
        sphereTriangles.forEach((vertex, at) => {
          indices[local * sphereTriangles.length + at] = local * verticesPerParticle + vertex
        })
      else indices[local] = local
    }
    geometries.push({
      positions,
      colors,
      indices,
      primitive: radius ? 'triangles' : 'points',
      ...(!radius ? { pointSizes: new Float32Array(length).fill(pointSize) } : {}),
    })
  }
  return { geometries, bounds, ...(range ? { minimum: range[0], maximum: range[1] } : {}) }
}
