import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { CAD_COMPILER_VERSION, type CompiledCadSource, type CompiledGeometryModule } from '../compiler/types'
import type { GeometryCoordinate } from '../source/geometrySnapshot'
import { runtimeDiagnostic } from './runtimeDiagnostics'

const sourceHash = 'c'.repeat(64)

describe('runtime source-map diagnostics', () => {
  it('maps a new Function stack frame back to the TSX source range', () => {
    const emitted = ts.transpileModule(
      `const fail = () => {
  throw new Error('boom')
}
fail()
`,
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          sourceMap: true,
          target: ts.ScriptTarget.ES2020,
        },
        fileName: 'structure.tsx',
      },
    )
    const generatedLines = emitted.outputText.split(/\r?\n/)
    const throwLine = generatedLines.findIndex((line) => line.includes("throw new Error('boom')")) + 1
    const throwColumn = generatedLines[throwLine - 1].indexOf('throw') + 1
    const source: CompiledCadSource = {
      apiVersion: 5,
      compilerVersion: CAD_COMPILER_VERSION,
      entryFile: 'structure.tsx',
      code: emitted.outputText,
      sourceMap: emitted.sourceMapText,
      sourceHash,
    }
    const error = new Error('boom')
    error.stack = `Error: boom\n    at fail (caemble://${sourceHash}/structure.tsx:${throwLine + 2}:${throwColumn})`

    expect(runtimeDiagnostic(error, source)).toMatchObject({
      code: 'CAD_RUNTIME',
      file: 'structure.tsx',
      message: 'boom',
      phase: 'runtime',
      range: { startLineNumber: 2 },
      severity: 'error',
    })
  })

  it('ignores stack frames from another compiled project', () => {
    const source: CompiledCadSource = {
      apiVersion: 5,
      compilerVersion: CAD_COMPILER_VERSION,
      entryFile: 'structure.tsx',
      code: '',
      sourceHash,
    }
    const error = new Error('boom')
    error.stack = `Error: boom\n    at caemble://${'d'.repeat(64)}/structure.tsx:3:1`

    expect(runtimeDiagnostic(error, source)).toBeUndefined()
  })

  it('attributes encoded Geometry module frames to their exact coordinate', () => {
    const coordinate = 'caemble:geometry/jlee/demo/block@1.0.0' as GeometryCoordinate
    const source: CompiledGeometryModule = {
      apiVersion: 5,
      compilerVersion: CAD_COMPILER_VERSION,
      entryFile: coordinate,
      code: '',
      sourceHash,
      geometrySourceHash: 'd'.repeat(64),
      moduleHash: 'e'.repeat(64),
      exports: ['Block'],
      imports: [],
    }
    const error = new Error('geometry boom')
    error.stack = `Error: geometry boom\n    at caemble://${sourceHash}/geometry/${encodeURIComponent(coordinate)}:5:3`

    expect(runtimeDiagnostic(error, source)).toMatchObject({
      file: coordinate,
      message: 'geometry boom',
      range: { startLineNumber: 3, startColumn: 3 },
    })
  })
})
