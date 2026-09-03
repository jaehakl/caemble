import type { CalculationDataTarget } from '@/api'

export type CalculationDataBatchSummary = Readonly<{
  total: number
  completed: number
  succeeded: number
  failed: number
  cancelled: boolean
}>

export async function executeCalculationDataBatch<TInput>({
  execute,
  loadMeasurement,
  onFailure,
  onProgress,
  onTarget,
  signal,
  targets,
}: {
  execute: (target: CalculationDataTarget, input: TInput) => Promise<void>
  loadMeasurement: (measurementId: number) => Promise<TInput>
  onFailure?: (target: CalculationDataTarget, cause: unknown) => void
  onProgress?: (summary: CalculationDataBatchSummary) => void
  onTarget?: (target: CalculationDataTarget) => void
  signal: AbortSignal
  targets: readonly CalculationDataTarget[]
}): Promise<CalculationDataBatchSummary> {
  const inputs = new Map<number, Promise<TInput>>()
  let summary: CalculationDataBatchSummary = {
    total: targets.length,
    completed: 0,
    succeeded: 0,
    failed: 0,
    cancelled: false,
  }
  onProgress?.(summary)
  for (const target of targets) {
    if (signal.aborted) break
    onTarget?.(target)
    try {
      let input = inputs.get(target.measurement_id)
      if (!input) {
        input = loadMeasurement(target.measurement_id)
        inputs.set(target.measurement_id, input)
      }
      await execute(target, await input)
      summary = { ...summary, completed: summary.completed + 1, succeeded: summary.succeeded + 1 }
    } catch (cause: unknown) {
      if (signal.aborted) break
      onFailure?.(target, cause)
      summary = { ...summary, completed: summary.completed + 1, failed: summary.failed + 1 }
    }
    onProgress?.(summary)
  }
  summary = { ...summary, cancelled: signal.aborted }
  onProgress?.(summary)
  return summary
}
