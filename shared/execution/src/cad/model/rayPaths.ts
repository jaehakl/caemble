export type PolylineBundle = Readonly<{
  id: string
  pathCount: number
  segmentCount: number
  vertices: Float32Array
  pathOffsets: Uint32Array
  segmentPower: Float32Array
  pathWavelength: Float32Array
  segmentEvent: Uint8Array
}>
