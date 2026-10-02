import type { PredictionTensorLayout } from './types'

/** Wire values include Cartesian complex channels and optional modal frequencies. */
export function predictionTensorValueCount(layout: PredictionTensorLayout) {
  const elementCount = layout.shape.reduce((size, length) => {
    if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(size * length))
      throw new Error('Prediction tensor shape is invalid or too large.')
    return size * length
  }, 1)
  const size =
    elementCount * (layout.dtype === 'complex64' ? 2 : 1) + (layout.frequencyOutput ? (layout.shape[4] ?? 0) : 0)
  if (!Number.isSafeInteger(size)) throw new Error('Prediction tensor shape is too large.')
  return size
}
