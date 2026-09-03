import type { UserData } from '@/api'

export type PrivateQueryScope = 'public' | `user:${string}`

export const authQueryKey = ['auth', 'me'] as const

export const privateQueryKeys = {
  all: ['private-data'] as const,
  scope: (scope: PrivateQueryScope) => [...privateQueryKeys.all, scope] as const,
}

export const privateCacheQueryRoots = [
  privateQueryKeys.all,
  ['admin'],
  ['ai-agent'],
  ['cae-workbench'],
  ['experiment'],
  ['materials'],
  ['runtime'],
  ['work'],
] as const

export function privateQueryScope(user: Pick<UserData, 'id' | 'is_active'> | null | undefined): PrivateQueryScope {
  return user?.is_active ? `user:${user.id}` : 'public'
}
