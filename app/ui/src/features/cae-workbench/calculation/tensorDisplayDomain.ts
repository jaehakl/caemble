export function fitTensorDisplayDomain(values: readonly number[]) {
  const finite = values.filter(Number.isFinite)
  if (!finite.length) return [-1, 1] as const
  const minimum = finite.reduce((current, value) => Math.min(current, value), Number.POSITIVE_INFINITY)
  const maximum = finite.reduce((current, value) => Math.max(current, value), Number.NEGATIVE_INFINITY)
  if (minimum === maximum) {
    const padding = minimum === 0 ? 0.5 : Math.abs(minimum) * 0.05
    return [minimum - padding, maximum + padding] as const
  }
  const scale = Math.max(Math.abs(minimum), Math.abs(maximum))
  const padding = (maximum / scale - minimum / scale) * 0.05 * scale
  return [Math.max(-Number.MAX_VALUE, minimum - padding), Math.min(Number.MAX_VALUE, maximum + padding)] as const
}
