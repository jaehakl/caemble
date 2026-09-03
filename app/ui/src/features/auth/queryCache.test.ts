import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { clearPrivateQueryCache, clearPrivateQueryScope } from './queryCache'
import { authQueryKey, privateQueryKeys } from './queryKeys'

describe('private Query cache ownership', () => {
  it('uses distinct roots for different accounts', () => {
    expect(privateQueryKeys.scope('user:first')).not.toEqual(privateQueryKeys.scope('user:second'))
  })

  it('drops the previous account scope without touching the next account', () => {
    const client = new QueryClient()
    client.setQueryData([...privateQueryKeys.scope('user:first'), 'experiment'], { secret: 'first' })
    client.setQueryData([...privateQueryKeys.scope('user:second'), 'experiment'], { secret: 'second' })

    clearPrivateQueryScope(client, 'user:first')

    expect(client.getQueryData([...privateQueryKeys.scope('user:first'), 'experiment'])).toBeUndefined()
    expect(client.getQueryData([...privateQueryKeys.scope('user:second'), 'experiment'])).toEqual({ secret: 'second' })
  })

  it('removes private and legacy private data without clearing public catalog data', () => {
    const client = new QueryClient()
    client.setQueryData([...privateQueryKeys.scope('user:first'), 'experiment'], { secret: true })
    client.setQueryData(['materials', 'legacy'], { secret: true })
    client.setQueryData(['catalog', 'meta'], { revision: 'public' })
    client.setQueryData(authQueryKey, { id: 'first' })

    clearPrivateQueryCache(client)

    expect(client.getQueryData([...privateQueryKeys.scope('user:first'), 'experiment'])).toBeUndefined()
    expect(client.getQueryData(['materials', 'legacy'])).toBeUndefined()
    expect(client.getQueryData(['catalog', 'meta'])).toEqual({ revision: 'public' })
    expect(client.getQueryData(authQueryKey)).toEqual({ id: 'first' })
  })
})
