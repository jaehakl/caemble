import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping'
import type { CompiledCadSource } from '../compiler/types'
import type { CadDiagnostic } from '../worker/protocol'

export function runtimeDiagnostic(error: Error, compiledSource: CompiledCadSource): CadDiagnostic | undefined {
  const stackFrame = error.stack?.match(/caemble:\/\/([0-9a-f]{64})\/(.+?):(\d+):(\d+)/)
  if (!stackFrame || stackFrame[1] !== compiledSource.sourceHash) return undefined
  const generatedLine = Math.max(1, Number(stackFrame[3]) - 2)
  const generatedColumn = Math.max(0, Number(stackFrame[4]) - 1)
  let file = stackFrame[2]
  let line = generatedLine
  let column = generatedColumn
  if (compiledSource.sourceMap) {
    const original = originalPositionFor(new TraceMap(compiledSource.sourceMap), {
      line: generatedLine,
      column: generatedColumn,
    })
    if (original.source && original.line !== null && original.column !== null) {
      file = original.source.replace(/^.*\/caemble-project\/[0-9a-f]{64}\//, '')
      line = original.line
      column = original.column
    }
  }
  return Object.freeze({
    code: 'CAD_RUNTIME',
    file,
    message: error.message,
    phase: 'runtime' as const,
    range: Object.freeze({
      startLineNumber: line,
      startColumn: column + 1,
      endLineNumber: line,
      endColumn: column + 2,
    }),
    severity: 'error' as const,
  })
}
