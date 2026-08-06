export type SimulationCompatibilityIssue = Readonly<{
  documentType?: 'structure' | 'experiment'
  path: string
  message: string
}>

export type SimulationCompatibility = Readonly<{
  status: 'unavailable' | 'checking' | 'compatible' | 'incompatible'
  issues: readonly SimulationCompatibilityIssue[]
}>

export type SimulationProcess = Readonly<{
  runId: string | null
  status: 'idle' | 'preparing' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  engine: Readonly<{ name: string; version: string }> | null
  stage: string | null
  error: string | null
  startedAt: number | null
  finishedAt: number | null
}>
