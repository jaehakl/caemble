import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { authQueryKey } from '@/features/auth/queryKeys'
import { calculationDataQueryKeys, calculationQueryKeys } from '@/features/calculation/queryKeys'
import { measurementQueryKeys } from '@/features/measurement/queryKeys'
import { invalidateExperimentMutation } from './queryInvalidation'
import { experimentQueryKeys } from './queryKeys'

describe('Experiment Query invalidation', () => {
  it('invalidates only the changed Experiment and its account-scoped dependants', async () => {
    const client = new QueryClient()
    const targetKeys = [
      experimentQueryKeys.detail('user:first', 7),
      experimentQueryKeys.records('user:first', 7),
      measurementQueryKeys.lists('user:first', 7),
      calculationQueryKeys.lists('user:first', 7),
      calculationDataQueryKeys.forExperiment('user:first', 7),
    ]
    const untouchedKeys = [
      experimentQueryKeys.detail('user:first', 8),
      experimentQueryKeys.records('user:first', 8),
      measurementQueryKeys.lists('user:first', 8),
      calculationQueryKeys.lists('user:first', 8),
      calculationDataQueryKeys.forExperiment('user:first', 8),
      experimentQueryKeys.detail('user:second', 7),
    ]
    client.setQueryData(authQueryKey, { id: 'first' })
    for (const key of [...targetKeys, ...untouchedKeys]) client.setQueryData(key, [])

    await invalidateExperimentMutation(client, 'user:first', 7)

    for (const key of targetKeys) expect(client.getQueryState(key)?.isInvalidated).toBe(true)
    for (const key of untouchedKeys) expect(client.getQueryState(key)?.isInvalidated).toBe(false)
    expect(client.getQueryState(authQueryKey)?.isInvalidated).toBe(true)
  })
})
