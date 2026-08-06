import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { useState, type ReactNode } from 'react'
import { Toaster } from 'sonner'
import { CurrentCadSelectionProvider } from '@/features/viewer/current-cad-selection'

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 30_000 },
          mutations: { retry: false },
        },
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      <CurrentCadSelectionProvider>
        <TooltipPrimitive.Provider delayDuration={300}>
          {children}
          <Toaster closeButton position="bottom-right" richColors />
        </TooltipPrimitive.Provider>
      </CurrentCadSelectionProvider>
    </QueryClientProvider>
  )
}
