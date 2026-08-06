import { createBrowserRouter, Outlet, redirect } from 'react-router'
import { RouteErrorPage } from '@/pages/error/RouteErrorPage'
import { viewerReplacementPath } from './legacy-routes'
import { AppShell } from './layout/AppShell'

export function redirectViewerToStructures(request: Request) {
  return redirect(viewerReplacementPath(new URL(request.url).search))
}

export const appRoutePaths = [
  'index',
  'viewer',
  'structures',
  'experiments',
  'examples/:exampleId?',
  'measurements',
  'analysis',
  'materials',
  'materials/:materialId',
  'catalog/cad/:tag?',
  'catalog/materials/:key?',
  'catalog/quantity-kinds/:name?',
  'catalog/solvers/:name?/:version?',
  'docs',
  'login',
  'account',
  '*',
] as const

export function createAppRouter() {
  return createBrowserRouter([
    {
      path: '/',
      Component: AppShell,
      ErrorBoundary: RouteErrorPage,
      hydrateFallbackElement: (
        <div className="flex h-dvh min-h-[600px] items-center justify-center bg-background px-6 text-foreground">
          <div className="text-center">
            <div className="mx-auto size-10 animate-pulse rounded-xl bg-primary" />
            <p className="mt-4 text-sm font-medium">Caemble을 불러오는 중입니다.</p>
          </div>
        </div>
      ),
      children: [
        { index: true, lazy: () => import('@/pages/home/HomePage') },
        { path: 'viewer', loader: ({ request }) => redirectViewerToStructures(request) },
        { path: 'structures', lazy: () => import('@/pages/structures/StructurePage') },
        { path: 'experiments', lazy: () => import('@/pages/experiments/ExperimentPage') },
        { path: 'examples/:exampleId?', lazy: () => import('@/pages/examples/ExamplesPage') },
        { path: 'measurements', lazy: () => import('@/pages/measurements/MeasurementPage') },
        { path: 'analysis', lazy: () => import('@/pages/analysis/AnalysisPage') },
        { path: 'materials', lazy: () => import('@/pages/materials/MaterialListPage') },
        { path: 'materials/:materialId', lazy: () => import('@/pages/materials/MaterialDetailPage') },
        {
          path: 'catalog',
          id: 'catalog',
          Component: Outlet,
          ErrorBoundary: RouteErrorPage,
          children: [
            { path: 'cad/:tag?', id: 'catalog-cad', lazy: () => import('@/pages/catalog/cad/CadCatalogPage') },
            {
              path: 'materials/:key?',
              id: 'catalog-materials',
              lazy: () => import('@/pages/catalog/materials/MaterialCatalogPage'),
            },
            {
              path: 'quantity-kinds/:name?',
              id: 'catalog-quantity-kinds',
              lazy: () => import('@/pages/catalog/quantity-kinds/QuantityKindCatalogPage'),
            },
            {
              path: 'solvers/:name?/:version?',
              id: 'catalog-solvers',
              lazy: () => import('@/pages/catalog/solvers/SolverCatalogPage'),
            },
          ],
        },
        { path: 'docs', lazy: () => import('@/pages/docs/DocsPage') },
        { path: 'login', lazy: () => import('@/pages/login/LoginPage') },
        { path: 'account', lazy: () => import('@/pages/account/AccountPage') },
        { path: '*', lazy: () => import('@/pages/not-found/NotFoundPage') },
      ],
    },
  ])
}
