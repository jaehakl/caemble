import { createBrowserRouter, Navigate, useLocation } from 'react-router'
import { legacyDocsHref } from '@/documentation/helpNavigation'
import { RouteErrorPage } from '@/features/error/RouteErrorPage'

export const appRoutePaths = ['index', 'docs', '*'] as const

export function createAppRouter() {
  return createBrowserRouter([
    {
      path: '/',
      lazy: () => import('@/routes/CaeRoute'),
      ErrorBoundary: RouteErrorPage,
      hydrateFallbackElement: (
        <div className="flex h-dvh min-h-[560px] items-center justify-center bg-background px-6 text-foreground">
          <div className="text-center">
            <div className="mx-auto size-10 animate-pulse rounded-xl bg-primary" />
            <p className="mt-4 text-sm font-medium">CAE Workbench를 불러오는 중입니다.</p>
          </div>
        </div>
      ),
    },
    {
      path: '/docs',
      Component: () => {
        const location = useLocation()
        return <Navigate replace to={legacyDocsHref(location.search, location.hash)} />
      },
    },
    {
      path: '*',
      lazy: () => import('@/routes/NotFoundRoute'),
      ErrorBoundary: RouteErrorPage,
      hydrateFallbackElement: <div />,
    },
  ])
}
