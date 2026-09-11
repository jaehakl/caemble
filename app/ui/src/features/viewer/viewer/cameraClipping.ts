/** Camera-space depth range of the visible content, independent of display units. */
export function cameraClipping(
  bounds: readonly [readonly number[], readonly number[]] | null,
  position: readonly number[],
  target: readonly number[],
) {
  if (!bounds) return { near: 0.01, far: 1000 }
  const [min, max] = bounds
  const diameter = Math.max(Math.hypot(...max.map((value, axis) => value - min[axis])), Number.EPSILON)
  const distance = Math.hypot(...target.map((value, axis) => value - position[axis]))
  const direction = target.map((value, axis) => (value - position[axis]) / (distance || 1))
  let closest = Infinity,
    furthest = -Infinity
  for (let corner = 0; corner < 8; corner++) {
    const depth = direction.reduce(
      (sum, value, axis) => sum + value * ((corner & (1 << axis) ? max[axis] : min[axis]) - position[axis]),
      0,
    )
    closest = Math.min(closest, depth)
    furthest = Math.max(furthest, depth)
  }
  const floor = diameter * 1e-6
  const near = Math.max(floor, closest - diameter * 0.05)
  const far = Math.max(near * 2, furthest + diameter * 0.05)
  return { near, far }
}

/** Moves a perspective camera by the fraction of its visible plane covered by a pointer drag. */
export function panCamera({
  aspect,
  deltaX,
  deltaY,
  fov,
  height,
  position,
  target,
  up,
  width,
}: {
  aspect: number
  deltaX: number
  deltaY: number
  fov: number
  height: number
  position: readonly number[]
  target: readonly number[]
  up: readonly number[]
  width: number
}) {
  const distance = Math.hypot(...target.map((value, axis) => value - position[axis]))
  if (!Number.isFinite(distance) || distance === 0 || width <= 0 || height <= 0) {
    return { position: [...position], target: [...target] }
  }
  const forward = target.map((value, axis) => (value - position[axis]) / distance)
  const cross = (left: readonly number[], right: readonly number[]) => [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ]
  const normalize = (vector: readonly number[]) => {
    const length = Math.hypot(...vector)
    return length > Number.EPSILON ? vector.map((value) => value / length) : null
  }
  const right =
    normalize(cross(forward, up)) ?? normalize(cross(forward, Math.abs(forward[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]))
  if (!right) return { position: [...position], target: [...target] }
  const screenUp = normalize(cross(right, forward))
  if (!screenUp) return { position: [...position], target: [...target] }
  const visibleHeight = 2 * distance * Math.tan(fov / 2)
  const visibleWidth = visibleHeight * aspect
  const offset = position.map(
    (_, axis) => right[axis] * (-deltaX / width) * visibleWidth + screenUp[axis] * (deltaY / height) * visibleHeight,
  )
  return {
    position: position.map((value, axis) => value + offset[axis]),
    target: target.map((value, axis) => value + offset[axis]),
  }
}
