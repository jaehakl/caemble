export type WorkbenchDialog =
  | 'account'
  | 'analysis'
  | 'ai-chat'
  | 'experiment-history'
  | 'publish-geometry-export'
  | 'jobs'
  | 'launchers'
  | 'load-experiment'
  | 'material'
  | 'measurement'
  | 'save-experiment'
  | 'save-experiment-as'
  | null

export type PendingConfirmation = Readonly<{
  title: string
  description: string
  confirmLabel?: string
  run: () => unknown | Promise<unknown>
}>
