export type WorkbenchDialog =
  | 'account'
  | 'analysis'
  | 'ai-chat'
  | 'jobs'
  | 'launchers'
  | 'material'
  | 'measurement'
  | 'save-experiment'
  | 'save-experiment-version'
  | 'save-experiment-as'
  | null

export type PendingConfirmation = Readonly<{
  title: string
  description: string
  confirmLabel?: string
  run: () => unknown | Promise<unknown>
}>
