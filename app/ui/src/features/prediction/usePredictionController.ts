import { useEffect, useRef } from 'react'
import { PredictionRuntimeController } from './predictionRuntime'

export { PredictionRuntimeController, type PredictionExecutionBinding } from './predictionRuntime'
export type {
  PreparedPredictionModel as PredictionModelCache,
  PreparedPredictionModel as PredictionForwardModelBundle,
  PredictionRecordProfile as PredictionForwardRecordProfile,
} from './execution'

export function usePredictionController() {
  const runtimeRef = useRef<PredictionRuntimeController | null>(null)
  if (!runtimeRef.current) runtimeRef.current = new PredictionRuntimeController()
  const runtime = runtimeRef.current
  useEffect(() => () => runtime.dispose(), [runtime])
  return runtime
}
