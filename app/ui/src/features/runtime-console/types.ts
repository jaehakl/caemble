export type RuntimeActivitySource = 'cad' | 'gpstation' | 'cae' | 'calculation' | 'prediction'

export type RuntimeActivityLevel = 'info' | 'warning' | 'error'

export type RuntimeActivityDetails = Readonly<Record<string, string | number | boolean | null>>

export type RuntimeActivityEvent = Readonly<{
  id: string
  timestamp: number
  source: RuntimeActivitySource
  level: RuntimeActivityLevel
  phase?: string
  message: string
  jobId?: string
  runId?: string
  progress?: number
  details?: RuntimeActivityDetails
}>

export type RuntimeActivityDraft = Readonly<
  Omit<RuntimeActivityEvent, 'id' | 'timestamp'> & Partial<Pick<RuntimeActivityEvent, 'id' | 'timestamp'>>
>

export type RuntimeActivityCallback = (activity: RuntimeActivityDraft) => void

export function emitRuntimeActivity(callback: RuntimeActivityCallback | undefined, activity: RuntimeActivityDraft) {
  try {
    callback?.(activity)
  } catch {
    // Observability must never change CAD evaluation or remote execution behavior.
  }
}
