import type { Meta, StoryObj } from '@storybook/react-vite'
import { http, HttpResponse } from 'msw'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { AppProviders } from '@/app/providers'
import { AppShell } from './AppShell'

const authenticatedUser = {
  id: 'd7929429-84f8-4d92-865d-dc638d8e64e0',
  email: 'designer@example.com',
  display_name: '김설계',
  picture_url: null,
  is_active: true,
  created_at: '2026-07-21T00:00:00Z',
  updated_at: '2026-07-21T00:00:00Z',
  roles: ['user'],
}

function ShellPreview() {
  const router = createMemoryRouter([
    {
      path: '/',
      Component: AppShell,
      children: [
        {
          index: true,
          element: (
            <div className="p-8">
              <h2 className="text-2xl font-semibold">페이지 콘텐츠</h2>
              <p className="mt-2 text-muted-foreground">App Shell의 반응형 탐색과 계정 상태를 확인합니다.</p>
            </div>
          ),
        },
      ],
    },
  ])
  return (
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  )
}

const meta = {
  title: 'App/App Shell',
  component: ShellPreview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ShellPreview>

export default meta
type Story = StoryObj<typeof meta>

export const Anonymous: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get('*/api/auth/me', () => HttpResponse.json({ detail: 'Not authenticated' }, { status: 401 })),
        http.get('*/api/auth/refresh', () => HttpResponse.json({ detail: 'No refresh token' }, { status: 401 })),
      ],
    },
  },
}

export const Authenticated: Story = {
  parameters: {
    msw: { handlers: [http.get('*/api/auth/me', () => HttpResponse.json(authenticatedUser))] },
  },
}
