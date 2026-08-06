import { RouterProvider } from 'react-router/dom'
import { AppProviders } from '@/app/providers'
import { createAppRouter } from '@/app/router'
import { redirectLegacyHash } from '@/app/legacy-routes'

redirectLegacyHash(window.location, window.history)
const router = createAppRouter()

export default function App() {
  return (
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  )
}
