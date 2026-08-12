export type WorkbenchDialog =
  | 'account'
  | 'analysis'
  | 'ai-chat'
  | 'ai-helper'
  | 'experiment-history'
  | 'jobs'
  | 'launchers'
  | 'load-experiment'
  | 'material'
  | 'measurement'
  | 'new-experiment'
  | 'save-experiment'
  | 'save-experiment-as'
  | null

export type PendingConfirmation = Readonly<{
  title: string
  description: string
  confirmLabel?: string
  run: () => unknown | Promise<unknown>
}>
