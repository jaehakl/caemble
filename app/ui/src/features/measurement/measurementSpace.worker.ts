import { fitMeasurementProjection, type VarsPoint } from './measurementSpace'
import type { VarsSchema } from '@/lib/cad/model/vars'

self.onmessage = (event: MessageEvent<{ id: number; schema: VarsSchema; points: VarsPoint[] }>) => {
  const { id, schema, points } = event.data
  try {
    self.postMessage({ id, projection: fitMeasurementProjection(schema, points) })
  } catch (cause) {
    self.postMessage({ id, error: cause instanceof Error ? cause.message : String(cause) })
  }
}
