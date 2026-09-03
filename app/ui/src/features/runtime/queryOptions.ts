import { queryOptions } from '@tanstack/react-query'
import { dbTables } from '@/api'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { runtimeQueryKeys } from './queryKeys'

export function accessKeysQueryOptions(scope: PrivateQueryScope, enabled: boolean) {
  return queryOptions({
    queryKey: runtimeQueryKeys.accessKeys(scope),
    queryFn: ({ signal }) => dbTables.AccessKey.list({ signal }),
    enabled,
  })
}

export function jobsQueryOptions(scope: PrivateQueryScope, activeOnly: boolean, enabled: boolean) {
  return queryOptions({
    queryKey: runtimeQueryKeys.jobs(scope, activeOnly),
    queryFn: ({ signal }) => dbTables.Job.list(activeOnly, { signal }),
    enabled,
    refetchInterval: activeOnly ? 10_000 : false,
  })
}

export function launchersQueryOptions(scope: PrivateQueryScope, enabled: boolean) {
  return queryOptions({
    queryKey: runtimeQueryKeys.launchers(scope),
    queryFn: async ({ signal }) => {
      const [rows, runtime] = await Promise.all([
        dbTables.Launcher.list({ signal }),
        dbTables.Launcher.runtime({ signal }),
      ])
      return { rows: rows.items, runtime }
    },
    enabled,
    refetchInterval: 15_000,
  })
}
