export type WorkbenchDialog =
  | 'account'
  | 'analysis'
  | 'ai-chat'
  | 'experiment-history'
  | 'geometry-catalog'
  | 'jobs'
  | 'launchers'
  | 'load-experiment'
  | 'load-research'
  | 'load-structure'
  | 'material'
  | 'material-catalog'
  | 'manual'
  | 'measurement'
  | 'new-experiment'
  | 'new-research'
  | 'new-structure'
  | 'other-experiments'
  | 'other-structures'
  | 'physics-catalog'
  | 'quantity-catalog'
  | 'sample'
  | 'save-experiment'
  | 'save-experiment-as'
  | 'save-structure'
  | 'save-structure-as'
  | 'setup'
  | 'structure-history'
  | null

export type PendingConfirmation = Readonly<{
  title: string
  description: string
  confirmLabel?: string
  run: () => unknown | Promise<unknown>
}>
