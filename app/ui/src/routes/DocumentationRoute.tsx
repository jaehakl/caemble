import { useCallback, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { HelpWorkspace } from '@/features/help/HelpWorkspace'
import { readHelpLocation } from '@/documentation/helpNavigation'

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

  return (
    <main className="h-full min-h-0 overflow-hidden">
      <HelpWorkspace {...helpLocation} onNavigate={navigateDocumentation} />
    </main>
  )
}

export const Component = DocumentationPage
