import { useCallback, useMemo } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { HelpWorkspace } from '@/features/help/HelpWorkspace'
import { helpHref, readHelpLocation } from '@/documentation/helpNavigation'
import { documentationAnchorRedirects } from '@/documentation/anchorRedirects'

export function DocumentationPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const helpLocation = useMemo(
    () => readHelpLocation(location.search) ?? { kind: 'home' as const, item: null, anchor: null },
    [location.search],
  )
  const navigateDocumentation = useCallback(
    (href: string) => {
      const target = new URL(href, window.location.origin)
      navigate({ pathname: '/doc', search: target.search, hash: '' })
    },
    [navigate],
  )

  const redirect =
    helpLocation.kind === 'manual' && helpLocation.item && helpLocation.anchor
      ? documentationAnchorRedirects[helpLocation.item]?.[helpLocation.anchor]
      : undefined
  if (redirect) return <Navigate to={helpHref('manual', redirect.item, redirect.anchor)} replace />

  return (
    <main className="h-full min-h-0 overflow-hidden">
      <HelpWorkspace {...helpLocation} onNavigate={navigateDocumentation} />
    </main>
  )
}

export const Component = DocumentationPage
