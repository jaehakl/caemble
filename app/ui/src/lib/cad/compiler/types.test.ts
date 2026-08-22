import { describe, expect, it } from 'vitest'
import { CAD_API_DECLARATION_FINGERPRINT } from '../api/generatedVersions'
import {
  CAD_COMPILER_VERSION,
  assertCompiledCadDocument,
  assertCompiledCadSource,
  type CompiledCadSource,
} from './types'

const sourceHash = 'a'.repeat(64)

function compiled(entryFile = 'experiment.tsx'): CompiledCadSource {
  return {
    apiVersion: 8,
    compilerVersion: CAD_COMPILER_VERSION,
    entryFile,
    code: '"use strict";',
    sourceHash,
  }
}

function compiledDocument(extra: Readonly<Record<string, CompiledCadSource>> = {}) {
  return {
    apiVersion: 8 as const,
    compilerVersion: CAD_COMPILER_VERSION,
    sourceHash,
    sources: {
      'experiment.tsx': compiled(),
      'geometry.tsx': compiled('geometry.tsx'),
      'material.tsx': compiled('material.tsx'),
      ...extra,
    },
  }
}

describe('compiled Experiment bundle', () => {
  it('binds compiler provenance to generated declarations and accepts arbitrary TS/TSX modules', () => {
    expect(CAD_API_DECLARATION_FINGERPRINT).toMatch(/^[0-9a-f]{64}$/)
    expect(CAD_COMPILER_VERSION).toContain('-api-8-')
    expect(CAD_COMPILER_VERSION).toContain(CAD_API_DECLARATION_FINGERPRINT)
    expect(() => assertCompiledCadSource(compiled('shared/helper.ts'))).not.toThrow()
    expect(() =>
      assertCompiledCadDocument(compiledDocument({ 'shared/helper.tsx': compiled('shared/helper.tsx') })),
    ).not.toThrow()
  })

  it('rejects unsupported entries, version drift, extra fields, and removed Geometry graphs', () => {
    expect(() => assertCompiledCadSource({ ...compiled(), modules: {} })).toThrow('provenance is invalid')
    expect(() => assertCompiledCadSource({ ...compiled(), apiVersion: 2 })).toThrow('provenance is invalid')
    expect(() => assertCompiledCadSource({ ...compiled(), entryFile: 'simulate.py' })).toThrow('provenance is invalid')
    expect(() => assertCompiledCadSource({ ...compiled(), entryFile: 'types.d.ts' })).toThrow('provenance is invalid')
    expect(() => assertCompiledCadDocument({ ...compiledDocument(), geometryGraph: {} })).toThrow(
      'provenance is invalid',
    )
  })

  it('requires all three compiled core modules and exact case-safe provenance', () => {
    const missingGeometry = compiledDocument()
    delete (missingGeometry.sources as Partial<typeof missingGeometry.sources>)['geometry.tsx']
    expect(() => assertCompiledCadDocument(missingGeometry)).toThrow('missing required')
    expect(() =>
      assertCompiledCadDocument(
        compiledDocument({
          'shared/Part.ts': compiled('shared/Part.ts'),
          'shared/part.ts': compiled('shared/part.ts'),
        }),
      ),
    ).toThrow('differ only by case')
    expect(() =>
      assertCompiledCadDocument(
        compiledDocument({ 'shared/helper.ts': { ...compiled('shared/helper.ts'), sourceHash: 'b'.repeat(64) } }),
      ),
    ).toThrow('does not match')
  })
})
