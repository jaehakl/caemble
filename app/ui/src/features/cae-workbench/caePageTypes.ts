export type WorkbenchDialog = 'account' | 'save-experiment' | 'save-experiment-version' | 'save-experiment-as' | null

export type PendingConfirmation = Readonly<{
  title: string
  description: string
  confirmLabel?: string
  cancel?: () => void
  run: () => unknown | Promise<unknown>
}>
