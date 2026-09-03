import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { privateQueryKeys } from '@/features/auth/queryKeys'

export const materialQueryKeys = {
  all: (scope: PrivateQueryScope) => [...privateQueryKeys.scope(scope), 'materials'] as const,
  list: (scope: PrivateQueryScope, visibility: 'visible' | 'mine' | 'public') =>
    [...materialQueryKeys.all(scope), 'list', { visibility }] as const,
  namesList: (scope: PrivateQueryScope, visibility: 'visible' | 'mine' | 'public') =>
    [...materialQueryKeys.all(scope), 'names-list', { visibility }] as const,
  detail: (scope: PrivateQueryScope, materialId: number) =>
    [...materialQueryKeys.all(scope), 'detail', materialId] as const,
  names: (scope: PrivateQueryScope, materialId: number) =>
    [...materialQueryKeys.detail(scope, materialId), 'names'] as const,
  parameters: (scope: PrivateQueryScope, materialId: number) =>
    [...materialQueryKeys.detail(scope, materialId), 'parameters'] as const,
  qualifiers: (scope: PrivateQueryScope, materialId: number, parameterIds: readonly number[]) =>
    [...materialQueryKeys.detail(scope, materialId), 'qualifiers', parameterIds] as const,
}
