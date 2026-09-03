import {
  PredictionModelError,
  PREDICTION_NUMERIC_CELL_LIMIT,
  PREDICTION_WORKING_SET_LIMIT_BYTES,
  type PredictionTensorLayout,
  type PredictionTensorSample,
} from './knn'

export type PredictionSamplingRange = Readonly<{ min: number; max: number }>

export type PredictionSamplingOptions = Readonly<{
  fingerprint: string
  totalAttempts: number
  layouts: readonly PredictionTensorLayout[]
  ranges: Readonly<Record<string, PredictionSamplingRange>>
  centers: readonly (readonly PredictionTensorSample[])[]
}>

export type PredictionSamplingProfile = Readonly<{
  activeBlockCount: number
  activeComponentCount: number
  existingCenterCount: number
  candidateCount: number
}>

export type PredictionSamplingSession = {
  readonly fingerprint: string
  readonly totalAttempts: number
  readonly layouts: readonly PredictionTensorLayout[]
  readonly ranges: Readonly<Record<string, PredictionSamplingRange>>
  readonly activeLayoutIndexes: readonly number[]
  readonly activeComponentCount: number
  readonly candidateCount: number
  readonly centers: number[][]
  readonly emitted: Set<string>
}

function elementCount(shape: readonly number[]) {
  return shape.reduce((total, length) => {
    if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(total * length)) {
      throw new PredictionModelError('invalid-data', 'Sampling Vars shape가 올바르지 않거나 너무 큽니다.')
    }
    return total * length
  }, 1)
}

function hash32(value: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function greatestCommonDivisor(left: number, right: number) {
  while (right !== 0) {
    const remainder = left % right
    left = right
    right = remainder
  }
  return left
}

function sampleKey(values: readonly number[]) {
  return values.map((value) => value.toPrecision(17)).join('|')
}

function flattenCenter(
  samples: readonly PredictionTensorSample[],
  layouts: readonly PredictionTensorLayout[],
  ranges: Readonly<Record<string, PredictionSamplingRange>>,
) {
  const byKey = new Map(samples.map((sample) => [sample.layout.key, sample]))
  const values: number[] = []
  for (const layout of layouts) {
    const range = ranges[layout.key]
    const sample = byKey.get(layout.key)
    const count = elementCount(layout.shape)
    if (!range || !sample || sample.values.length !== count) return null
    for (const value of sample.values) {
      if (!Number.isFinite(value) || value < range.min || value > range.max) return null
      values.push(value)
    }
  }
  return values
}

export function createPredictionSamplingSession(options: PredictionSamplingOptions): Readonly<{
  session: PredictionSamplingSession
  profile: PredictionSamplingProfile
}> {
  if (!options.fingerprint || !Number.isSafeInteger(options.totalAttempts) || options.totalAttempts <= 0) {
    throw new PredictionModelError('invalid-data', 'Sampling N은 양의 JavaScript safe integer여야 합니다.')
  }
  if (options.layouts.length === 0) throw new PredictionModelError('invalid-data', 'Sampling할 Vars가 없습니다.')

  let totalComponents = 0
  let activeComponentCount = 0
  const activeLayoutIndexes: number[] = []
  options.layouts.forEach((layout, layoutIndex) => {
    const range = options.ranges[layout.key]
    if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) {
      throw new PredictionModelError('invalid-data', `Sampling 범위 ${layout.key}가 올바르지 않습니다.`)
    }
    if (
      range.min > range.max ||
      (layout.minimum !== undefined && range.min < layout.minimum) ||
      (layout.maximum !== undefined && range.max > layout.maximum)
    ) {
      throw new PredictionModelError('invalid-data', `Sampling 범위 ${layout.key}가 schema 범위를 벗어났습니다.`)
    }
    const count = elementCount(layout.shape)
    totalComponents += count
    if (range.min < range.max) {
      activeLayoutIndexes.push(layoutIndex)
      activeComponentCount += count
    }
  })
  if (activeComponentCount === 0) {
    throw new PredictionModelError(
      'invalid-data',
      'Sampling에는 범위가 고정되지 않은 component가 하나 이상 필요합니다.',
    )
  }

  const uniqueCenters = new Map<string, number[]>()
  options.centers.forEach((samples) => {
    const values = flattenCenter(samples, options.layouts, options.ranges)
    if (values) uniqueCenters.set(sampleKey(values), values)
  })
  const projectedCenterCount = uniqueCenters.size + options.totalAttempts
  if (
    !Number.isSafeInteger(projectedCenterCount * totalComponents) ||
    projectedCenterCount * totalComponents > PREDICTION_NUMERIC_CELL_LIMIT ||
    projectedCenterCount * totalComponents * Float64Array.BYTES_PER_ELEMENT > PREDICTION_WORKING_SET_LIMIT_BYTES
  ) {
    throw new PredictionModelError('memory-limit', 'Sampling 데이터가 Prediction Worker 안전 한도를 초과합니다.')
  }
  const candidateCount = Math.min(4096, Math.floor(8_000_000 / (projectedCenterCount * activeComponentCount)))
  if (candidateCount < 32) {
    throw new PredictionModelError('memory-limit', 'Sampling 후보 안전 예산이 32개 미만입니다. N 또는 범위를 줄이세요.')
  }

  const session: PredictionSamplingSession = {
    fingerprint: options.fingerprint,
    totalAttempts: options.totalAttempts,
    layouts: options.layouts,
    ranges: options.ranges,
    activeLayoutIndexes,
    activeComponentCount,
    candidateCount,
    centers: [...uniqueCenters.values()],
    emitted: new Set<string>(),
  }
  return {
    session,
    profile: {
      activeBlockCount: activeLayoutIndexes.length,
      activeComponentCount,
      existingCenterCount: uniqueCenters.size,
      candidateCount,
    },
  }
}

function minimumDistanceSquared(session: PredictionSamplingSession, candidate: readonly number[]) {
  let minimum = Number.POSITIVE_INFINITY
  for (const center of session.centers) {
    let blockTotal = 0
    let offset = 0
    for (const layout of session.layouts) {
      const count = elementCount(layout.shape)
      const range = session.ranges[layout.key]
      if (range.min < range.max) {
        let componentTotal = 0
        for (let component = 0; component < count; component += 1) {
          const delta = (candidate[offset + component] - center[offset + component]) / (range.max - range.min)
          componentTotal += delta * delta
        }
        blockTotal += componentTotal / count
      }
      offset += count
    }
    minimum = Math.min(minimum, blockTotal / session.activeLayoutIndexes.length)
  }
  return minimum
}

function candidateValues(session: PredictionSamplingSession, attempt: number, candidateIndex: number) {
  const values: number[] = []
  let activeComponent = 0
  for (const layout of session.layouts) {
    const count = elementCount(layout.shape)
    const range = session.ranges[layout.key]
    for (let component = 0; component < count; component += 1) {
      if (range.min === range.max) {
        values.push(range.min)
        continue
      }
      const seed = `${session.fingerprint}|${attempt}|${activeComponent}`
      let multiplier = hash32(`${seed}|a`) % session.candidateCount || 1
      while (greatestCommonDivisor(multiplier, session.candidateCount) !== 1) multiplier += 1
      const offset = hash32(`${seed}|b`) % session.candidateCount
      const stratum = (Math.imul(multiplier, candidateIndex) + offset) % session.candidateCount
      const jitter = hash32(`${seed}|${candidateIndex}|j`) / 0x1_0000_0000
      values.push(range.min + ((stratum + jitter) / session.candidateCount) * (range.max - range.min))
      activeComponent += 1
    }
  }
  return values
}

function toSamples(session: PredictionSamplingSession, values: readonly number[]) {
  let offset = 0
  return Object.freeze(
    session.layouts.map((layout) => {
      const count = elementCount(layout.shape)
      const sample = Object.freeze({ layout, values: Object.freeze(values.slice(offset, offset + count)) })
      offset += count
      return sample
    }),
  )
}

export function nextPredictionSamplingCandidate(
  session: PredictionSamplingSession,
  attempt: number,
): readonly PredictionTensorSample[] {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > session.totalAttempts) {
    throw new PredictionModelError('invalid-data', 'Sampling 시도 번호가 올바르지 않습니다.')
  }
  if (session.centers.length === 0 && attempt === 1) {
    const midpoint = session.layouts.flatMap((layout) => {
      const range = session.ranges[layout.key]
      return Array.from({ length: elementCount(layout.shape) }, () => (range.min + range.max) / 2)
    })
    session.emitted.add(sampleKey(midpoint))
    return toSamples(session, midpoint)
  }

  let best: number[] | null = null
  let bestDistance = Number.NEGATIVE_INFINITY
  for (let candidateIndex = 0; candidateIndex < session.candidateCount; candidateIndex += 1) {
    const candidate = candidateValues(session, attempt, candidateIndex)
    if (session.emitted.has(sampleKey(candidate))) continue
    const distance = minimumDistanceSquared(session, candidate)
    if (distance > bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  if (!best) throw new PredictionModelError('invalid-data', '중복되지 않는 Sampling 후보를 만들 수 없습니다.')
  session.emitted.add(sampleKey(best))
  return toSamples(session, best)
}

export function acceptPredictionSamplingCenter(
  session: PredictionSamplingSession,
  samples: readonly PredictionTensorSample[],
) {
  const values = flattenCenter(samples, session.layouts, session.ranges)
  if (!values) throw new PredictionModelError('invalid-data', '성공한 Sampling center가 현재 범위와 일치하지 않습니다.')
  const key = sampleKey(values)
  if (!session.centers.some((center) => sampleKey(center) === key)) session.centers.push(values)
  return session.centers.length
}
