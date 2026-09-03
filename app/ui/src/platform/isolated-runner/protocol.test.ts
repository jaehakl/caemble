import { describe, expect, it } from 'vitest'
import { resolveRunnerReadyHostOrigin } from './protocol'

describe('isolated runner host origin validation', () => {
  const allowedOrigins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173'])

  it('accepts only an exact allowed origin', () => {
    expect(resolveRunnerReadyHostOrigin('?hostOrigin=http%3A%2F%2Flocalhost%3A5173', allowedOrigins)).toBe(
      'http://localhost:5173',
    )
  })

  it.each([
    '?hostOrigin=http%3A%2F%2Flocalhost%3A5173%2Fpath',
    '?hostOrigin=https%3A%2F%2Fexample.com',
    '?hostOrigin=not-a-url',
    '',
  ])('rejects an invalid or unapproved host origin: %s', (search) => {
    expect(resolveRunnerReadyHostOrigin(search, allowedOrigins)).toBeUndefined()
  })
})
