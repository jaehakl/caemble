import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { calculationDataQueryKeys } from '@/features/calculation/queryKeys'
import { invalidateMeasurementMutation } from './queryInvalidation'
import { measurementQueryKeys } from './queryKeys'

describe('Measurement Query invalidation', () => {
  it('invalidates the selected Experiment and Measurement without crossing account or Experiment scope', async () => {
    const client = new QueryClient()
    const targetKeys = [
      measurementQueryKeys.lists('user:first', 7),
      measurementQueryKeys.detail('user:first', 'mine', 11),
      measurementQueryKeys.detail('user:first', 'visible', 11),
      measurementQueryKeys.recordedData('user:first', 11),
      calculationDataQueryKeys.forExperiment('user:first', 7),
    ]
    const untouchedKeys = [
      measurementQueryKeys.lists('user:first', 8),
      measurementQueryKeys.detail('user:first', 'mine', 12),
      calculationDataQueryKeys.forExperiment('user:first', 8),
      measurementQueryKeys.lists('user:second', 7),
    ]
    for (const key of [...targetKeys, ...untouchedKeys]) client.setQueryData(key, [])

    await invalidateMeasurementMutation(client, 'user:first', 7, [11])

    for (const key of targetKeys) expect(client.getQueryState(key)?.isInvalidated).toBe(true)
    for (const key of untouchedKeys) expect(client.getQueryState(key)?.isInvalidated).toBe(false)
  })
})
