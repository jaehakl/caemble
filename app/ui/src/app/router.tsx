import { createBrowserRouter } from 'react-router'
import { RouteErrorPage } from '@/pages/error/RouteErrorPage'

export const appRoutePaths = ['index', '*'] as const

export function createAppRouter() {
  return createBrowserRouter([
    {
      path: '/',
      lazy: () => import('@/pages/cae/CaePage'),
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
      path: '*',
      lazy: () => import('@/pages/not-found/NotFoundPage'),
      ErrorBoundary: RouteErrorPage,
      hydrateFallbackElement: <div />,
    },
  ])
}
