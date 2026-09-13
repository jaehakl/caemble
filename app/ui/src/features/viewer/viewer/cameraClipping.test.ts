import { describe, expect, it } from 'vitest'
import { fitCameraToBounds, panCamera } from './cameraClipping'

describe('fitCameraToBounds', () => {
  it.each([1e-6, 1e-3, 1])('fits off-center content tightly at scale %s in narrow and wide viewports', (scale) => {
    for (const width of [200, 800]) {
      const min = [10, 20, 30].map((value) => value * scale)
      const max = [14, 21, 32].map((value) => value * scale)
      const fitted = fitCameraToBounds({
        bounds: [min, max],
        position: [0, -100, 0],
        target: [0, 0, 0],
        up: [0, 0, 1],
        fov: Math.PI / 4,
        width,
        height: 600,
      })!
      expect(fitted.target[0] / scale).toBeCloseTo(12)
      expect(fitted.target[1] / scale).toBeCloseTo(20.5)
      expect(fitted.target[2] / scale).toBeCloseTo(31)
      let largest = 0
      for (let corner = 0; corner < 8; corner++) {
        const position = min.map((value, axis) => (corner & (1 << axis) ? max[axis] : value))
        const depth = position[1] - fitted.position[1]
        expect(depth).toBeGreaterThan(0)
        const x = Math.abs((position[0] - fitted.target[0]) / ((depth * Math.tan(Math.PI / 8) * width) / 600))
        const y = Math.abs((position[2] - fitted.target[2]) / (depth * Math.tan(Math.PI / 8)))
        expect(x).toBeLessThanOrEqual(0.9)
        expect(y).toBeLessThanOrEqual(0.9)
        largest = Math.max(largest, x, y)
      }
      expect(largest).toBeGreaterThan(0.89)
    }
  })
  it('waits for valid content and viewport dimensions', () => {
    const input = {
      bounds: [
        [0, 0, 0],
        [1, 1, 1],
      ] as const,
      position: [1, 1, 1],
      target: [0, 0, 0],
      up: [0, 0, 1],
      fov: Math.PI / 4,
      width: 800,
      height: 600,
    }
    expect(fitCameraToBounds({ ...input, bounds: null })).toBeNull()
    expect(fitCameraToBounds({ ...input, width: 0 })).toBeNull()
    expect(fitCameraToBounds({ ...input, height: 0 })).toBeNull()
    expect(
      fitCameraToBounds({
        ...input,
        bounds: [
          [0, 0, 0],
          [Infinity, 1, 1],
        ],
      }),
    ).toBeNull()
  })
})

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
