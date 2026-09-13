/** Perspective scale at the camera target plane, measured in CSS pixels. */
export function viewerScaleBar(distance: number, fov: number, height: number) {
  const perPixel = (2 * distance * Math.tan(fov / 2)) / height
  if (!Number.isFinite(perPixel) || perPixel <= 0) return null
  const desired = perPixel * 120
  const power = 10 ** Math.floor(Math.log10(desired))
  const length = ([5, 2, 1].find((step) => step * power <= desired) ?? 1) * power
  return { length, width: length / perPixel }
}
