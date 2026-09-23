import { describe, expect, it } from 'vitest'
import { fitCameraToBounds, panCamera, rotateCameraAroundPivot, spinCameraUp } from './cameraClipping'

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

describe('rotateCameraAroundPivot', () => {
  const projection = (camera: { position: number[]; target: number[]; up: number[] }, point: number[]) => {
    const cross = (left: number[], right: number[]) => [
      left[1] * right[2] - left[2] * right[1],
      left[2] * right[0] - left[0] * right[2],
      left[0] * right[1] - left[1] * right[0],
    ]
    const dot = (left: number[], right: number[]) => left.reduce((sum, value, axis) => sum + value * right[axis], 0)
    const normalize = (vector: number[]) => vector.map((value) => value / Math.hypot(...vector))
    const forward = normalize(camera.target.map((value, axis) => value - camera.position[axis]))
    const right = normalize(cross(forward, camera.up))
    const screenUp = cross(right, forward)
    const offset = point.map((value, axis) => value - camera.position[axis])
    const depth = dot(offset, forward)
    return [dot(offset, right) / depth, dot(offset, screenUp) / depth]
  }

  it('keeps the world origin at the same screen location with an offset target', () => {
    const camera = { position: [3, -10, 5], target: [2, -1, 1], up: [0, 0, 1] }
    const before = projection(camera, [0, 0, 0])
    const rotated = rotateCameraAroundPivot({ ...camera, pivot: [0, 0, 0], deltaX: 30, deltaY: 20, speed: 0.006 })!
    const after = projection(rotated, [0, 0, 0])
    after.forEach((value, axis) => expect(value).toBeCloseTo(before[axis], 8))
    expect(Math.hypot(...rotated.position)).toBeCloseTo(Math.hypot(...camera.position), 8)
    expect(Math.hypot(...rotated.target)).toBeCloseTo(Math.hypot(...camera.target), 8)
    expect(Math.hypot(...rotated.up)).toBeCloseTo(1, 8)
  })

  it('makes scene landmarks follow rightward and downward drags', () => {
    const camera = { position: [0, -10, 0], target: [0, 0, 0], up: [0, 0, 1] }
    const landmark = [0, 1, 0]
    const right = rotateCameraAroundPivot({ ...camera, pivot: [0, 0, 0], deltaX: 10, deltaY: 0, speed: 0.006 })!
    const down = rotateCameraAroundPivot({ ...camera, pivot: [0, 0, 0], deltaX: 0, deltaY: 10, speed: 0.006 })!
    expect(projection(right, landmark)[0]).toBeGreaterThan(0)
    expect(projection(down, landmark)[1]).toBeLessThan(0)
  })

  it('keeps an offset selected center fixed on screen while rotating the whole camera pose', () => {
    const pivot = [12, -3, 5]
    const camera = { position: [3, -10, 5], target: [2, -1, 1], up: [0, 0, 1] }
    const before = projection(camera, pivot)
    const rotated = rotateCameraAroundPivot({ ...camera, pivot, deltaX: 30, deltaY: 20, speed: 0.006 })!
    projection(rotated, pivot).forEach((value, axis) => expect(value).toBeCloseTo(before[axis], 8))
    for (const key of ['position', 'target'] as const) {
      expect(Math.hypot(...rotated[key].map((value, axis) => value - pivot[axis]))).toBeCloseTo(
        Math.hypot(...camera[key].map((value, axis) => value - pivot[axis])),
        8,
      )
    }
    expect(Math.hypot(...rotated.up)).toBeCloseTo(1, 8)
  })
})

describe('spinCameraUp', () => {
  it('rolls around the current view direction without depending on the world origin', () => {
    const pose = { position: [3, -10, 5], target: [3, 0, 5], up: [0, 0, 1] }
    const clockwise = spinCameraUp({ ...pose, angle: -Math.PI / 2 })!
    const counterclockwise = spinCameraUp({ ...pose, angle: Math.PI / 2 })!
    expect(clockwise[0]).toBeCloseTo(-1)
    expect(clockwise[1]).toBeCloseTo(0)
    expect(clockwise[2]).toBeCloseTo(0)
    expect(counterclockwise[0]).toBeCloseTo(1)
    expect(Math.hypot(...clockwise)).toBeCloseTo(1)
    expect(pose.position).toEqual([3, -10, 5])
    expect(pose.target).toEqual([3, 0, 5])
  })

  it('ignores invalid camera poses and angles', () => {
    const pose = { position: [0, -10, 0], target: [0, 0, 0], up: [0, 0, 1] }
    expect(spinCameraUp({ ...pose, target: pose.position, angle: 1 })).toBeNull()
    expect(spinCameraUp({ ...pose, up: [0, 0, 0], angle: 1 })).toBeNull()
    expect(spinCameraUp({ ...pose, angle: Infinity })).toBeNull()
  })
})
