/** Fits every bounding-box corner inside the perspective viewport with a 10% margin. */
export function fitCameraToBounds({
  bounds,
  position,
  target,
  up,
  fov,
  width,
  height,
}: {
  bounds: readonly [readonly number[], readonly number[]] | null
  position: readonly number[]
  target: readonly number[]
  up: readonly number[]
  fov: number
  width: number
  height: number
}) {
  if (
    !bounds ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isFinite(fov) ||
    fov <= 0 ||
    fov >= Math.PI
  )
    return null
  const [min, max] = bounds
  if (min.some((value, axis) => !Number.isFinite(value) || !Number.isFinite(max[axis]) || max[axis] < value))
    return null
  const diameter = Math.hypot(...max.map((value, axis) => value - min[axis]))
  if (!Number.isFinite(diameter) || diameter <= 0) return null
  const center = min.map((value, axis) => value + (max[axis] - value) / 2)
  const distance = Math.hypot(...target.map((value, axis) => value - position[axis]))
  const forward =
    Number.isFinite(distance) && distance > 0
      ? target.map((value, axis) => (value - position[axis]) / distance)
      : [-1 / Math.sqrt(3), -1 / Math.sqrt(3), -1 / Math.sqrt(3)]
  const cross = (left: readonly number[], right: readonly number[]) => [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ]
  let cameraUp = up
  let right = cross(forward, cameraUp)
  if (!Number.isFinite(Math.hypot(...right)) || Math.hypot(...right) < 1e-12) {
    cameraUp = Math.abs(forward[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    right = cross(forward, cameraUp)
  }
  const rightLength = Math.hypot(...right)
  right = right.map((value) => value / rightLength)
  const screenUp = cross(right, forward)
  const vertical = Math.tan(fov / 2) * 0.9
  const horizontal = (vertical * width) / height
  let fittedDistance = diameter * 1e-4
  for (let corner = 0; corner < 8; corner++) {
    const offset = center.map((value, axis) => (corner & (1 << axis) ? max[axis] : min[axis]) - value)
    const depth = offset.reduce((sum, value, axis) => sum + value * forward[axis], 0)
    const x = offset.reduce((sum, value, axis) => sum + value * right[axis], 0)
    const y = offset.reduce((sum, value, axis) => sum + value * screenUp[axis], 0)
    fittedDistance = Math.max(fittedDistance, Math.abs(x) / horizontal - depth, Math.abs(y) / vertical - depth)
  }
  const fittedPosition = center.map((value, axis) => value - forward[axis] * (fittedDistance + diameter * 1e-4))
  if (!fittedPosition.every(Number.isFinite)) return null
  return { position: fittedPosition, target: center, up: [...cameraUp] }
}

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

/** Rotates the camera pose about a world-space pivot so the scene follows the pointer. */
export function rotateCameraAroundPivot({
  deltaX,
  deltaY,
  pivot,
  position,
  target,
  up,
  speed,
}: {
  deltaX: number
  deltaY: number
  pivot: readonly number[]
  position: readonly number[]
  target: readonly number[]
  up: readonly number[]
  speed: number
}) {
  const upLength = Math.hypot(...up)
  const viewLength = Math.hypot(...target.map((value, axis) => value - position[axis]))
  if (!Number.isFinite(upLength) || upLength === 0 || !Number.isFinite(viewLength) || viewLength === 0) return null

  const cross = (left: readonly number[], right: readonly number[]) => [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ]
  const rotate = (vector: readonly number[], axis: readonly number[], angle: number) => {
    const cosine = Math.cos(angle)
    const sine = Math.sin(angle)
    const perpendicular = cross(axis, vector)
    const projection = axis.reduce((sum, value, index) => sum + value * vector[index], 0)
    return vector.map(
      (value, index) => value * cosine + perpendicular[index] * sine + axis[index] * projection * (1 - cosine),
    )
  }

  const yawAxis = up.map((value) => value / upLength)
  const yaw = deltaX * speed
  const pitch = deltaY * speed
  const yawedPosition = rotate(
    position.map((value, axis) => value - pivot[axis]),
    yawAxis,
    yaw,
  )
  const yawedTarget = rotate(
    target.map((value, axis) => value - pivot[axis]),
    yawAxis,
    yaw,
  )
  const yawedUp = rotate(up, yawAxis, yaw)
  const forward = yawedTarget.map((value, axis) => value - yawedPosition[axis])
  let right = cross(forward, yawedUp)
  let rightLength = Math.hypot(...right)
  if (!Number.isFinite(rightLength) || rightLength < 1e-12) {
    right = cross(forward, Math.abs(forward[1]) < viewLength * 0.9 ? [0, 1, 0] : [1, 0, 0])
    rightLength = Math.hypot(...right)
  }
  if (!Number.isFinite(rightLength) || rightLength === 0) return null
  const pitchAxis = right.map((value) => value / rightLength)
  return {
    position: rotate(yawedPosition, pitchAxis, pitch).map((value, axis) => value + pivot[axis]),
    target: rotate(yawedTarget, pitchAxis, pitch).map((value, axis) => value + pivot[axis]),
    up: rotate(yawedUp, pitchAxis, pitch),
  }
}
