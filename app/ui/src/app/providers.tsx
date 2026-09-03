import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Toaster } from 'sonner'
import { clearPrivateQueryScope } from '@/features/auth/queryCache'
import { privateQueryScope, type PrivateQueryScope } from '@/features/auth/queryKeys'
import { authQueryOptions } from '@/features/auth/queryOptions'

function PrivateQueryAccountBoundary() {
  const queryClient = useQueryClient()
  const user = useQuery(authQueryOptions).data
  const scope = privateQueryScope(user)
  const previousScope = useRef<PrivateQueryScope>(scope)

  useEffect(() => {
    if (previousScope.current !== scope) clearPrivateQueryScope(queryClient, previousScope.current)
    previousScope.current = scope
  }, [queryClient, scope])

  return null
}

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
      <PrivateQueryAccountBoundary />
      <TooltipPrimitive.Provider delayDuration={300}>
        {children}
        <Toaster closeButton position="bottom-right" richColors />
      </TooltipPrimitive.Provider>
    </QueryClientProvider>
  )
}
