export const BOX_GRID_AXES = ['x', 'y', 'z', 'time', 'frequency', 'amplitudePhase', 'component'] as const

export type BoxGridVector = readonly [number, number, number]
export type BoxGridProfile = Readonly<{
  version: 1
  sampling: 'point' | 'cell-average' | 'aggregate'
  components: readonly string[]
  channels: readonly ['value'] | readonly ['amplitude', 'phase']
  channelUnits: readonly string[]
  frequencyKind?: 'modal' | 'sampled'
}>

/** World position = origin + rotation * local position; local bounds are [0, size]. */
export type BoxGridGeometry = Readonly<{
  origin: BoxGridVector
  size: BoxGridVector
  rotation: readonly [BoxGridVector, BoxGridVector, BoxGridVector]
  lengthUnit: string
  gridShape: readonly [number, number, number]
  source: 'experiment' | 'task'
  rootId: string
}>

export type BoxGridData = BoxGridProfile & BoxGridGeometry

export function assertBoxGridProfile(value: unknown): asserts value is BoxGridProfile {
  if (!value || typeof value !== 'object') throw new Error('A Box Grid profile is required.')
  const profile = value as BoxGridProfile
  if (profile.version !== 1 || !['point', 'cell-average', 'aggregate'].includes(profile.sampling))
    throw new Error('Unsupported Box Grid profile.')
  if (
    !Array.isArray(profile.components) ||
    !profile.components.length ||
    profile.components.some((component) => typeof component !== 'string' || !component) ||
    new Set(profile.components).size !== profile.components.length
  )
    throw new Error('Box Grid components must be unique nonempty labels.')
  const channels = JSON.stringify(profile.channels)
  if (channels !== '["value"]' && channels !== '["amplitude","phase"]')
    throw new Error('Box Grid channels must be value or amplitude/phase.')
  if (
    !Array.isArray(profile.channelUnits) ||
    profile.channelUnits.length !== profile.channels.length ||
    profile.channelUnits.some((unit) => typeof unit !== 'string' || !unit) ||
    (profile.channels.length === 2 && profile.channelUnits[1] !== 'rad')
  )
    throw new Error('Box Grid channel units must include phase in radians.')
  if (profile.frequencyKind !== undefined && !['modal', 'sampled'].includes(profile.frequencyKind))
    throw new Error('Unsupported Box Grid frequency meaning.')
}

export function assertBoxGridData(value: unknown, shape?: readonly number[]): asserts value is BoxGridData {
  assertBoxGridProfile(value)
  const grid = value as BoxGridData
  const vectors = [grid.origin, grid.size, ...(Array.isArray(grid.rotation) ? grid.rotation : [])]
  if (
    vectors.length !== 5 ||
    vectors.some(
      (vector) => !Array.isArray(vector) || vector.length !== 3 || vector.some((item) => !Number.isFinite(item)),
    ) ||
    grid.size.some((item) => item <= 0)
  )
    throw new Error('Box Grid requires finite origin, positive size, and a 3 by 3 rotation.')
  if (
    !Array.isArray(grid.gridShape) ||
    grid.gridShape.length !== 3 ||
    grid.gridShape.some((length) => !Number.isSafeInteger(length) || length < 1)
  )
    throw new Error('Box Grid gridShape requires three positive integers.')
  if (!['experiment', 'task'].includes(grid.source) || !grid.rootId || !grid.lengthUnit)
    throw new Error('Box Grid requires geometry identity and length unit.')
  for (let row = 0; row < 3; row += 1) {
    for (let other = 0; other < 3; other += 1) {
      const dot = grid.rotation[row].reduce((sum, item, column) => sum + item * grid.rotation[other][column], 0)
      if (Math.abs(dot - Number(row === other)) > 1e-8) throw new Error('Box Grid rotation must be orthonormal.')
    }
  }
  if (grid.sampling === 'aggregate' && grid.gridShape.some((length) => length !== 1))
    throw new Error('Aggregate Outputs require gridShape=[1,1,1].')
  if (
    shape &&
    (shape.length !== 7 ||
      shape.some((length) => !Number.isSafeInteger(length) || length < 1) ||
      grid.gridShape.some((length, axis) => shape[axis] !== length) ||
      shape[5] !== grid.channels.length ||
      shape[6] !== grid.components.length)
  )
    throw new Error('Box Grid tensor shape must match its seven axes and metadata.')
}
