export function viewerReplacementPath(search: string) {
  const searchParams = new URLSearchParams(search)
  searchParams.set('structure', 'new')
  searchParams.set('mode', 'code')
  searchParams.delete('experiment')
  searchParams.delete('sample')
  searchParams.delete('setup')
  searchParams.delete('measurement')
  return `/structures?${searchParams}`
}

export function redirectLegacyHash(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState'>,
) {
  if (location.pathname !== '/') return
  if (location.hash === '#viewer') {
    history.replaceState(null, '', viewerReplacementPath(location.search))
  } else if (location.hash === '#help') {
    history.replaceState(null, '', `/docs${location.search}`)
  }
}
