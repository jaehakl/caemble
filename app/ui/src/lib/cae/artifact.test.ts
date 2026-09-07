import { describe, expect, it } from 'vitest'
import { parseArtifactInput } from './artifact'

const artifact = { source_hash: 'source' }
const measurement = { kind: 'measurement', experiment: { sourceHash: 'source' } }

describe('artifact item envelope', () => {
  it('accepts an omitted presentation and preserves the original input', () => {
    const input = { measurement }
    expect(parseArtifactInput(input, artifact)).toBe(input)
    const presented = { measurement, presentation: {} }
    expect(parseArtifactInput(presented, artifact)).toBe(presented)
  })

  it.each(['vars', 'material_parameters', 'warnings'])('rejects the build-only field %s', (key) => {
    expect(() => parseArtifactInput({ measurement, [key]: {} }, artifact)).toThrow(
      'Artifact item must contain measurement and optional presentation.',
    )
  })

  it.each([null, [], 'text', 1, undefined])('rejects invalid presentation %j', (presentation) => {
    expect(() => parseArtifactInput({ measurement, presentation }, artifact)).toThrow(
      'Artifact presentation must be an object.',
    )
  })

  it.each([null, [], 'text', 1])('rejects invalid item %j', (input) => {
    expect(() => parseArtifactInput(input, artifact)).toThrow(
      'Artifact item must contain measurement and optional presentation.',
    )
  })

  it('still rejects missing measurement and a mismatched source', () => {
    expect(() => parseArtifactInput({}, artifact)).toThrow('source hash')
    expect(() => parseArtifactInput({ measurement }, { source_hash: 'other' })).toThrow('source hash')
  })
})
