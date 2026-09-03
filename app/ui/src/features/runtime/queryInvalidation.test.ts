import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { invalidateLauncherMutation, invalidateRuntimeJobs } from './queryInvalidation'
import { runtimeQueryKeys } from './queryKeys'

describe('runtime Query invalidation', () => {
  it('invalidates every Job filter for one account only', async () => {
    const client = new QueryClient()
    client.setQueryData(runtimeQueryKeys.jobs('user:first', true), [])
    client.setQueryData(runtimeQueryKeys.jobs('user:first', false), [])
    client.setQueryData(runtimeQueryKeys.jobs('user:second', true), [])

    await invalidateRuntimeJobs(client, 'user:first')

    expect(client.getQueryState(runtimeQueryKeys.jobs('user:first', true))?.isInvalidated).toBe(true)
    expect(client.getQueryState(runtimeQueryKeys.jobs('user:first', false))?.isInvalidated).toBe(true)
    expect(client.getQueryState(runtimeQueryKeys.jobs('user:second', true))?.isInvalidated).toBe(false)
  })

  it('invalidates Launcher and dependent Job state together', async () => {
    const client = new QueryClient()
    client.setQueryData(runtimeQueryKeys.launchers('user:first'), [])
    client.setQueryData(runtimeQueryKeys.jobs('user:first', true), [])

    await invalidateLauncherMutation(client, 'user:first')

    expect(client.getQueryState(runtimeQueryKeys.launchers('user:first'))?.isInvalidated).toBe(true)
    expect(client.getQueryState(runtimeQueryKeys.jobs('user:first', true))?.isInvalidated).toBe(true)
  })
})
