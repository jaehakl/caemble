import { describe, expect, it } from 'vitest'
import { CAD_API_DECLARATION_FINGERPRINT } from '../api/generatedVersions'
import { CAD_COMPILER_VERSION, assertCompiledCadSource, type CompiledCadSource } from './types'

function compiled(): CompiledCadSource {
  return {
    apiVersion: 5,
    compilerVersion: CAD_COMPILER_VERSION,
    entryFile: 'experiment.tsx',
    code: '"use strict";',
    sourceHash: 'a'.repeat(64),
  }
}

describe('CompiledCadSource', () => {
  it('binds compiler provenance to all generated public declaration contents', () => {
    expect(CAD_API_DECLARATION_FINGERPRINT).toMatch(/^[0-9a-f]{64}$/)
    expect(CAD_COMPILER_VERSION).toContain(CAD_API_DECLARATION_FINGERPRINT)
    expect(() => assertCompiledCadSource(compiled())).not.toThrow()
  })

  it('rejects project modules, version drift, and extra fields', () => {
    expect(() => assertCompiledCadSource({ ...compiled(), modules: {} })).toThrow('modules is not allowed')
    expect(() => assertCompiledCadSource({ ...compiled(), apiVersion: 2 })).toThrow('provenance is invalid')
    expect(() => assertCompiledCadSource({ ...compiled(), entryFile: 'helper.ts' })).toThrow('provenance is invalid')
  })
})
