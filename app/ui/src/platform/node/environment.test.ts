import { describe, expect, it, vi } from 'vitest'
import { executionEnvironment } from './environment'

describe('auth process boundary', () => {
  it('does not forward API/provider credentials or Python/Node injection variables to code execution', () => {
    vi.stubEnv('CAEMBLE_API_TOKEN', 'secret')
    vi.stubEnv('OPENAI_API_KEY', 'secret')
    vi.stubEnv('PYTHONPATH', 'other-checkout')
    vi.stubEnv('NODE_OPTIONS', '--require injected.cjs')
    vi.stubEnv('CAEMBLE_API_URL', 'https://api.example')
    const environment = executionEnvironment()
    expect(environment).not.toHaveProperty('CAEMBLE_API_TOKEN')
    expect(environment).not.toHaveProperty('OPENAI_API_KEY')
    expect(environment).not.toHaveProperty('PYTHONPATH')
    expect(environment).not.toHaveProperty('NODE_OPTIONS')
    expect(environment).not.toHaveProperty('CAEMBLE_API_URL')
    expect(Object.keys(environment).some((key) => key.toLowerCase() === 'path')).toBe(true)
    vi.unstubAllEnvs()
  })
})
