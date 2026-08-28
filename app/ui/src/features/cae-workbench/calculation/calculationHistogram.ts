export type ScalarHistogramBin = Readonly<{ min: number; max: number; count: number }>

export type ScalarHistogram = Readonly<{
  bins: readonly ScalarHistogramBin[]
  domainMin: number
  domainMax: number
  markerRatio: number
  maximumCount: number
}>

export function buildScalarHistogram(values: readonly number[], current: number): ScalarHistogram | null {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0 || !Number.isFinite(current)) return null
  const minimum = Math.min(...finite)
  const maximum = Math.max(...finite)
  const binCount = Math.min(12, Math.max(1, Math.ceil(Math.sqrt(finite.length))))
  let bins: ScalarHistogramBin[]
  if (minimum === maximum) {
    bins = [{ min: minimum, max: maximum, count: finite.length }]
  } else {
    const width = (maximum - minimum) / binCount
    const counts = Array(binCount).fill(0) as number[]
    finite.forEach((value) => {
      counts[Math.min(binCount - 1, Math.floor((value - minimum) / width))] += 1
    })
    bins = counts.map((count, index) => ({
      min: minimum + width * index,
      max: index === binCount - 1 ? maximum : minimum + width * (index + 1),
      count,
    }))
  }

  let domainMin = Math.min(minimum, current)
  let domainMax = Math.max(maximum, current)
  if (domainMin === domainMax) {
    const padding = Math.max(1, Math.abs(domainMin) * 0.05)
    domainMin -= padding
    domainMax += padding
  }
  return Object.freeze({
    bins: Object.freeze(bins),
    domainMin,
    domainMax,
    markerRatio: (current - domainMin) / (domainMax - domainMin),
    maximumCount: Math.max(...bins.map((bin) => bin.count)),
  })
}
