import type { Tensor } from './types'

export function tensorElementCount(shape: readonly number[]) {
  return shape.reduce((count, length) => count * length, 1)
}

export function flattenVarsTensor(value: Tensor, shape: readonly number[], label = 'Candidate variable') {
  const flat: number[] = []
  const visit = (item: Tensor, depth: number) => {
    if (depth === shape.length) {
      if (typeof item !== 'number' || !Number.isFinite(item)) throw new Error(`${label} contains a non-finite value.`)
      flat.push(item)
      return
    }
    if (!Array.isArray(item) || item.length !== shape[depth]) {
      throw new Error(`${label} must have shape ${JSON.stringify(shape)}.`)
    }
    item.forEach((child) => visit(child, depth + 1))
  }
  visit(value, 0)
  return flat
}

export function varsTensorFromFlat(values: readonly number[], shape: readonly number[]): Tensor {
  let offset = 0
  const build = (depth: number): Tensor => {
    if (depth === shape.length) return values[offset++]
    return Object.freeze(Array.from({ length: shape[depth] }, () => build(depth + 1)))
  }
  return build(0)
}
