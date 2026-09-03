import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { measurementQueryKeys } from '@/features/measurement/queryKeys'
import { invalidateCalculationMutation } from './queryInvalidation'
import { calculationDataQueryKeys, calculationQueryKeys } from './queryKeys'

describe('Calculation Query invalidation', () => {
  it('invalidates one Experiment dependency family without crossing scope', async () => {
    const client = new QueryClient()
    const targetKeys = [
      calculationQueryKeys.lists('user:first', 7),
      calculationDataQueryKeys.scalars('user:first', 7, 21, null),
      measurementQueryKeys.lists('user:first', 7),
    ]
    const untouchedKeys = [
      calculationQueryKeys.lists('user:first', 8),
      calculationDataQueryKeys.scalars('user:first', 8, 21, null),
      measurementQueryKeys.lists('user:first', 8),
      calculationQueryKeys.lists('user:second', 7),
    ]
    for (const key of [...targetKeys, ...untouchedKeys]) client.setQueryData(key, [])

    await invalidateCalculationMutation(client, 'user:first', 7)

    for (const key of targetKeys) expect(client.getQueryState(key)?.isInvalidated).toBe(true)
    for (const key of untouchedKeys) expect(client.getQueryState(key)?.isInvalidated).toBe(false)
  })
})
