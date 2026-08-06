export function readMeasurementReturnTo(state: unknown) {
  if (typeof state !== 'object' || state === null || !('measurementReturnTo' in state)) return null
  const value = String(state.measurementReturnTo)
  const url = new URL(value, 'https://caemble.local')
  return url.pathname === '/measurements' ? `${url.pathname}${url.search}` : null
}

export function updateMeasurementReturnTo(
  returnTo: string,
  kind: 'experiment' | 'structure',
  selectedId: number | null,
) {
  const url = new URL(returnTo, 'https://caemble.local')
  const previousId = Number(url.searchParams.get(kind)) || null
  if (selectedId) url.searchParams.set(kind, String(selectedId))
  else url.searchParams.delete(kind)

  if (previousId !== selectedId) {
    url.searchParams.delete(kind === 'structure' ? 'sample' : 'setup')
    url.searchParams.delete('measurement')
  }
  return `${url.pathname}${url.search}`
}
