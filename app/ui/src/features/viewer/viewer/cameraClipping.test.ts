import { describe, expect, it } from 'vitest'
import { panCamera } from './cameraClipping'

describe('panCamera', () => {
  it.each([
    ['um', 1e-6],
    ['mm', 1e-3],
    ['m', 1],
  ])('moves %s cameras by the same fraction of the visible plane', (_, scale) => {
    const result = panCamera({
      aspect: 2,
      deltaX: 100,
      deltaY: 50,
      fov: Math.PI / 2,
      height: 500,
      position: [0, -10 * scale, 0],
      target: [0, 0, 0],
      up: [0, 0, 1],
      width: 1000,
    })

    expect(result.position[0] / scale).toBeCloseTo(-4)
    expect(result.position[2] / scale).toBeCloseTo(2)
    expect(result.target[0] / scale).toBeCloseTo(-4)
    expect(result.target[2] / scale).toBeCloseTo(2)
  })

  it('uses a fallback horizontal axis when the camera looks along its up axis', () => {
    const result = panCamera({
      aspect: 1,
      deltaX: 20,
      deltaY: 0,
      fov: Math.PI / 4,
      height: 100,
      position: [0, 0, 10],
      target: [0, 0, 0],
      up: [0, 0, 1],
      width: 100,
    })

    expect(result.position.every(Number.isFinite)).toBe(true)
    expect(result.target.every(Number.isFinite)).toBe(true)
    expect(result.target).not.toEqual([0, 0, 0])
  })
})
