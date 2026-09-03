import { queryOptions } from '@tanstack/react-query'
import { dbTables } from '@/api'
import { privateQueryKeys, type PrivateQueryScope } from '@/features/auth/queryKeys'

export const adminQueryKeys = {
  all: (scope: PrivateQueryScope) => [...privateQueryKeys.scope(scope), 'admin'] as const,
  users: (scope: PrivateQueryScope) => [...adminQueryKeys.all(scope), 'users'] as const,
}

export function adminUsersQueryOptions(scope: PrivateQueryScope) {
  return queryOptions({
    queryKey: adminQueryKeys.users(scope),
    queryFn: ({ signal }) => dbTables.User.getAllUsersAdmin(500, 0, { signal }),
  })
}
