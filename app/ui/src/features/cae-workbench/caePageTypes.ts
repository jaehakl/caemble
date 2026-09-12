export type WorkbenchDialog =
  'save-experiment' | 'save-experiment-version' | 'save-experiment-as' | 'templates' | 'experiment-info' | null

export type PendingConfirmation = Readonly<{
  title: string
  description: string
  confirmLabel?: string
  cancel?: () => void
  run: () => unknown | Promise<unknown>
}>
