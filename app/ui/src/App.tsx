import { RouterProvider } from 'react-router/dom'
import { AppProviders } from '@/app/providers'
import { createAppRouter } from '@/app/router'
const router = createAppRouter()

export default function App() {
  return (
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  )
}
