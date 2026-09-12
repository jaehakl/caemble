import { createBrowserRouter } from 'react-router'
import { AppShell } from '@/app/AppShell'
import { RouteErrorPage } from '@/features/error/RouteErrorPage'

export const appRoutePaths = [
  'index',
  'showcase',
  'workbench',
  'doc',
  'lab',
  'admin',
  'settings',
  'account',
  '*',
] as const

export function createAppRouter() {
  return createBrowserRouter([
    {
      Component: AppShell,
      ErrorBoundary: RouteErrorPage,
      children: [
        {
          index: true,
          lazy: () => import('@/routes/StartRoute'),
          hydrateFallbackElement: <div role="status">로그인 상태를 확인하는 중…</div>,
        },
        {
          path: 'showcase',
          lazy: () => import('@/routes/ShowcaseRoute'),
          hydrateFallbackElement: <div role="status">Showcase를 불러오는 중…</div>,
        },
        {
          path: 'workbench',
          lazy: () => import('@/routes/CaeRoute'),
          hydrateFallbackElement: (
            <div className="flex h-full min-h-[560px] items-center justify-center bg-background px-6 text-foreground">
              <div className="text-center">
                <div className="mx-auto size-10 animate-pulse rounded-xl bg-primary" />
                <p className="mt-4 text-sm font-medium">CAE Workbench를 불러오는 중입니다.</p>
              </div>
            </div>
          ),
        },
        { path: 'doc', lazy: () => import('@/routes/DocumentationRoute') },
        { path: 'lab', lazy: () => import('@/routes/LabRoute') },
        { path: 'admin', lazy: () => import('@/routes/AdminRoute') },
        { path: 'settings', lazy: () => import('@/routes/SettingsRoute') },
        { path: 'account', lazy: () => import('@/routes/AccountRoute') },
        { path: '*', lazy: () => import('@/routes/NotFoundRoute'), hydrateFallbackElement: <div /> },
      ],
    },
  ])
}
