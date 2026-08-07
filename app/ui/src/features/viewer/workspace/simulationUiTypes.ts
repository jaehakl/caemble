export type SimulationProcess = Readonly<{
  runId: string | null
  status: 'idle' | 'preparing' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  engine: Readonly<{ name: string; version: string }> | null
  stage: string | null
  error: string | null
  startedAt: number | null
  finishedAt: number | null
}>
