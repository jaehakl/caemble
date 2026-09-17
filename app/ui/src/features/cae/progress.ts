export function describeCaeProgress(value: unknown) {
  if (typeof value !== 'object' || value === null) return null
  const progress = value as Record<string, unknown>
  const message = [progress.task, progress.message ?? progress.stage ?? progress.status]
    .filter((part) => typeof part === 'string')
    .join(' · ')
  const completed = typeof progress.completed === 'number' ? progress.completed : null
  const total = typeof progress.total === 'number' && progress.total > 0 ? progress.total : null
  const physicalTime = progress.physicalTime
  if (typeof physicalTime === 'object' && physicalTime !== null) {
    const { completed: time, total: duration, dt } = physicalTime as Record<string, unknown>
    if (
      typeof time === 'number' &&
      Number.isFinite(time) &&
      time >= 0 &&
      typeof duration === 'number' &&
      Number.isFinite(duration) &&
      duration > 0 &&
      typeof dt === 'number' &&
      Number.isFinite(dt) &&
      dt >= 0
    ) {
      return {
        message: `${message} · 시간 ${Number(time.toPrecision(6))}/${Number(duration.toPrecision(6))} s · Δt ${Number(dt.toPrecision(4))} s${completed !== null ? ` · ${completed}${total === null ? '' : `/${total}`}` : ''}`,
        fraction: Math.max(0, Math.min(1, time / duration)),
      }
    }
  }
  return {
    message:
      `${message}${completed !== null ? ` · ${completed}${total === null ? '' : `/${total}`}` : ''}` ||
      JSON.stringify(progress),
    fraction: completed !== null && total !== null ? Math.max(0, Math.min(1, completed / total)) : undefined,
  }
}
