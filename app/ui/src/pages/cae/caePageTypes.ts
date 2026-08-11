export type WorkbenchDialog =
  | 'analysis'
  | 'experiment-history'
  | 'load-experiment'
  | 'load-research'
  | 'load-structure'
  | 'material'
  | 'measurement'
  | 'new-experiment'
  | 'new-research'
  | 'new-structure'
  | 'other-experiments'
  | 'other-structures'
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
