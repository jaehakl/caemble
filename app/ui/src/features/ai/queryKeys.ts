import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { privateQueryKeys } from '@/features/auth/queryKeys'

export const aiQueryKeys = {
  all: (scope: PrivateQueryScope) => [...privateQueryKeys.scope(scope), 'ai-agent'] as const,
  providers: (scope: PrivateQueryScope) => [...aiQueryKeys.all(scope), 'providers'] as const,
}
