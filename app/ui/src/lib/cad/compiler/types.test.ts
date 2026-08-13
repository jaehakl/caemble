import { describe, expect, it } from 'vitest'
import { CAD_API_DECLARATION_FINGERPRINT } from '../api/generatedVersions'
import {
  CAD_COMPILER_VERSION,
  assertCompiledCadDocument,
  assertCompiledCadSource,
  type CompiledCadSource,
} from './types'

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
    const coordinate = 'caemble:geometry/jlee/demo/block@1.0.0'
    expect(() => assertCompiledCadSource({ ...compiled(), entryFile: coordinate })).toThrow('provenance is invalid')
    expect(() =>
      assertCompiledCadDocument({
        apiVersion: 5,
        compilerVersion: CAD_COMPILER_VERSION,
        sourceHash: 'a'.repeat(64),
        sources: { [coordinate]: { ...compiled(), entryFile: coordinate } },
      }),
    ).toThrow('provenance is invalid')
  })

  it('rejects a depth-65 graph when its shared tail was first visited from a shallow root', () => {
    const sourceHash = 'a'.repeat(64)
    const moduleHash = 'b'.repeat(64)
    const coordinates = Array.from({ length: 65 }, (_, index) => `caemble:geometry/jlee/demo/node-${index}@1.0.0`)
    const modules = Object.fromEntries(
      coordinates.map((coordinate, index) => [
        coordinate,
        {
          ...compiled(),
          entryFile: coordinate,
          sourceHash,
          geometrySourceHash: 'c'.repeat(64),
          moduleHash,
          imports: index === coordinates.length - 1 ? [] : [coordinates[index + 1]],
        },
      ]),
    )
    const validModules = Object.fromEntries(
      Object.entries(modules).filter(([coordinate]) => coordinate !== coordinates[0]),
    )

    expect(() =>
      assertCompiledCadDocument({
        apiVersion: 5,
        compilerVersion: CAD_COMPILER_VERSION,
        sourceHash,
        sources: { 'experiment.tsx': compiled() },
        geometryGraph: {
          graphHash: 'd'.repeat(64),
          roots: [
            { alias: 'shallow', coordinate: coordinates[63], moduleHash },
            { alias: 'long', coordinate: coordinates[1], moduleHash },
          ],
          modules: validModules,
        },
      }),
    ).not.toThrow()

    expect(() =>
      assertCompiledCadDocument({
        apiVersion: 5,
        compilerVersion: CAD_COMPILER_VERSION,
        sourceHash,
        sources: { 'experiment.tsx': compiled() },
        geometryGraph: {
          graphHash: 'd'.repeat(64),
          roots: [
            { alias: 'shallow', coordinate: coordinates[63], moduleHash },
            { alias: 'long', coordinate: coordinates[0], moduleHash },
          ],
          modules,
        },
      }),
    ).toThrow('dependency depth 64')
  })
})
