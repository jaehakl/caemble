export function describeCaeProgress(value: unknown) {
  if (typeof value !== 'object' || value === null) return null
  const progress = value as Record<string, unknown>
  const message = [progress.task, progress.message ?? progress.stage ?? progress.status]
    .filter((part) => typeof part === 'string')
    .join(' · ')
  const completed = typeof progress.completed === 'number' ? progress.completed : null
  const total = typeof progress.total === 'number' && progress.total > 0 ? progress.total : null
  return {
    message:
      `${message}${completed !== null ? ` · ${completed}${total === null ? '' : `/${total}`}` : ''}` ||
      JSON.stringify(progress),
    fraction: completed !== null && total !== null ? Math.max(0, Math.min(1, completed / total)) : undefined,
  }
}
