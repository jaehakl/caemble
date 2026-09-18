import { expect, it, vi } from 'vitest'
import { createComparisonCamera, type ComparisonRenderer } from './comparisonCamera'
import { fitCameraToBounds } from './cameraClipping'

it('fits every corner of both scenes within unequal viewports and ignores hidden viewport sizes', () => {
  const camera = createComparisonCamera()
  const toolbar = {
    onPickModeChange: vi.fn(),
    onSetCameraView: vi.fn(),
    onToggleXray: vi.fn(),
    pickMode: 'off' as const,
    xrayEnabled: false,
  }
  const left: ComparisonRenderer = {
    apply: vi.fn(),
    bounds: () => [
      [-4, -2, -1],
      [0, 2, 1],
    ],
    viewport: () => ({ width: 900, height: 600 }),
    toolbar,
  }
  const right: ComparisonRenderer = {
    ...left,
    bounds: () => [
      [8, 1, 0],
      [12, 4, 3],
    ],
    viewport: () => ({ width: 200, height: 600 }),
  }
  camera.register({}, left)
  camera.register({}, right)
  camera.register({}, { ...left, bounds: () => null, viewport: () => ({ width: 0, height: 0 }) })
  const extent = camera.fitExtent()!
  const fov = Math.PI / 4
  const fitted = fitCameraToBounds({ ...extent, position: [0, 0, 20], target: [0, 0, 0], up: [0, 1, 0], fov })!
  expect(fitted.target).toEqual([4, 1, 1])
  for (const renderer of [left, right]) {
    const [min, max] = renderer.bounds()!
    const viewport = renderer.viewport()!
    for (let corner = 0; corner < 8; corner++) {
      const point = min.map((value, axis) => (corner & (1 << axis) ? max[axis] : value))
      const halfHeight = (fitted.position[2] - point[2]) * Math.tan(fov / 2)
      expect(Math.abs(point[0] - fitted.target[0])).toBeLessThan((halfHeight * viewport.width) / viewport.height)
      expect(Math.abs(point[1] - fitted.target[1])).toBeLessThan(halfHeight)
    }
  }
})

it('isolates camera snapshots and detaches removed renderers without losing the latest pose', () => {
  const camera = createComparisonCamera()
  const source = {},
    peer = {}
  const apply = vi.fn()
  const renderer: ComparisonRenderer = {
    apply,
    bounds: () => null,
    viewport: () => undefined,
    toolbar: {
      onPickModeChange: vi.fn(),
      onSetCameraView: vi.fn(),
      onToggleXray: vi.fn(),
      pickMode: 'off',
      xrayEnabled: false,
    },
  }
  camera.register(source, renderer)
  camera.register(peer, {
    ...renderer,
    apply: (pose) => {
      pose.position[0] = 999
    },
  })
  const pose = { position: [1, 2, 3], target: [0, 0, 0], up: [0, 0, 1], fov: 0.7 }
  camera.publish(source, pose)
  expect(apply).not.toHaveBeenCalled()
  expect(camera.current).toEqual(pose)
  camera.unregister(peer)
  camera.register(peer, renderer)
  expect(apply).toHaveBeenCalledWith(pose)
  camera.unregister(peer)
  apply.mockClear()
  camera.publish(source, pose)
  expect(apply).not.toHaveBeenCalled()
})

it('starts with a copied saved pose and applies it to each newly mounted renderer', () => {
  const pose = { position: [3, 4, 5], target: [0, 0, 0], up: [0, 0, 1], fov: 0.8 }
  const camera = createComparisonCamera(pose)
  pose.position[0] = 99
  expect(camera.current?.position[0]).toBe(3)
})
