import { queryOptions } from '@tanstack/react-query'
import { dbTables } from '@/api'
import { ApiError } from '@/api/http'
import { authQueryKey } from './queryKeys'

export const authQueryOptions = queryOptions({
  queryKey: authQueryKey,
  queryFn: async ({ signal }) => {
    try {
      return await dbTables.User.fetchMe({ signal })
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 401) return null
      throw error
    }
  },
  retry: false,
  staleTime: 60_000,
})
