import { createHash } from 'node:crypto'
import ts from 'typescript'
import type { AuthoringDiagnostic, AuthoringErrorMetadata } from '../../authoring/diagnostics'
import { calculationCompilerOptions } from '../../lib/calculation/compilerOptions'
import { CALCULATION_MONACO_DECLARATION } from '../../lib/calculation/declarations'
import { executeCalculation } from '../../lib/calculation/execute'
import { analyzeCalculationSource } from '../../lib/calculation/sourcePolicy'
import { transformCalculationSource } from '../../lib/calculation/transform'
import {
  CalculationExecutionError,
  type CalculationInput,
  type CompiledCalculationSource,
} from '../../lib/calculation/types'

/** Uses the browser's source policy, declarations and AST transform. Execution belongs in a disposable child. */
export async function compileNodeCalculation(source: string): Promise<CompiledCalculationSource> {
  const hash = createHash('sha256').update(source).digest('hex')
  try {
    const ast = analyzeCalculationSource(source)
    const sourcePath = '/caemble-calculation/calculation.js'
    const declarationsPath = '/caemble-calculation/calculation-env.d.ts'
    const options: ts.CompilerOptions = {
      ...calculationCompilerOptions(ts),
      noEmit: true,
      types: [],
      skipLibCheck: true,
    }
    const host = ts.createCompilerHost(options)
    const readFile = host.readFile.bind(host)
    const fileExists = host.fileExists.bind(host)
    host.readFile = (path) =>
      path === sourcePath ? source : path === declarationsPath ? CALCULATION_MONACO_DECLARATION : readFile(path)
    host.fileExists = (path) => path === sourcePath || path === declarationsPath || fileExists(path)
    host.getSourceFile = (path, languageVersion) => {
      const content = host.readFile(path)
      return content === undefined ? undefined : ts.createSourceFile(path, content, languageVersion, true)
    }
    const program = ts.createProgram([sourcePath, declarationsPath], options, host)
    const errors = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    )
    if (errors.length > 0) {
      const first = errors.find(
        (diagnostic) => diagnostic.file?.fileName === sourcePath && diagnostic.start !== undefined,
      )
      const start = first?.file?.getLineAndCharacterOfPosition(first.start!)
      const end = first?.file?.getLineAndCharacterOfPosition(first.start! + (first.length ?? 1))
      const message = errors
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
        .join('\n')
      const problem = new CalculationExecutionError(
        'compile',
        message,
        first && start && end
          ? {
              message: ts.flattenDiagnosticMessageText(first.messageText, '\n'),
              range: {
                startLineNumber: start.line + 1,
                startColumn: start.character + 1,
                endLineNumber: end.line + 1,
                endColumn: end.character + 1,
              },
              sourceLine: source.split(/\r?\n/)[start.line] ?? '',
            }
          : undefined,
      )
      const diagnostics: AuthoringDiagnostic[] = errors.map((diagnostic) => {
        const location =
          diagnostic.file && diagnostic.start !== undefined
            ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
            : undefined
        const endLocation =
          diagnostic.file && diagnostic.start !== undefined
            ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start + (diagnostic.length ?? 0))
            : undefined
        return {
          stage: 'compile',
          language: 'javascript',
          code: `TS${diagnostic.code}`,
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
          sourceHash: hash,
          referenceId: 'calculation.declarations',
          location: location
            ? {
                file: diagnostic.file!.fileName === sourcePath ? 'calculation.js' : diagnostic.file!.fileName,
                line: location.line + 1,
                column: location.character + 1,
              }
            : null,
          ...(diagnostic.file
            ? { file: diagnostic.file.fileName === sourcePath ? 'calculation.js' : diagnostic.file.fileName }
            : {}),
          ...(location && endLocation
            ? {
                range: {
                  startLineNumber: location.line + 1,
                  startColumn: location.character + 1,
                  endLineNumber: endLocation.line + 1,
                  endColumn: endLocation.character + 1,
                },
                sourceLine: diagnostic.file!.text.split(/\r?\n/)[location.line] ?? '',
              }
            : {}),
        }
      })
      throw Object.assign(problem, { diagnostics })
    }
    return transformCalculationSource(source, hash, ast)
  } catch (cause) {
    const problem = (cause instanceof Error ? cause : new Error(String(cause))) as Error & AuthoringErrorMetadata
    const stage = problem.code === 'policy' ? 'source-policy' : 'compile'
    const legacy = problem instanceof CalculationExecutionError ? problem.diagnostic : undefined
    throw Object.assign(problem, {
      stage,
      language: 'javascript',
      sourceHash: hash,
      referenceId: 'diagnostic.calculation',
      diagnostics: problem.diagnostics ?? [
        {
          stage,
          language: 'javascript',
          code: problem.code ?? 'compile',
          message: problem.message,
          sourceHash: hash,
          referenceId: problem.code === 'policy' ? 'calculation.policy' : 'calculation.declarations',
          location: legacy
            ? { file: 'calculation.js', line: legacy.range.startLineNumber, column: legacy.range.startColumn }
            : null,
          file: 'calculation.js',
          ...(legacy ? { range: legacy.range, sourceLine: legacy.sourceLine } : {}),
        },
      ],
    })
  }
}

export async function runNodeCalculation(source: string, input: CalculationInput) {
  const compiled = await compileNodeCalculation(source)
  const logs: string[] = []
  try {
    const output = executeCalculation(compiled, input, (message) => logs.push(message))
    return { sourceHash: compiled.sourceHash, output, logs }
  } catch (cause) {
    const problem = cause instanceof Error ? cause : new Error(String(cause))
    const legacy = problem instanceof CalculationExecutionError ? problem.diagnostic : undefined
    const code = problem instanceof CalculationExecutionError ? problem.code : 'runtime'
    throw Object.assign(problem, {
      code,
      stage: 'execution',
      language: 'javascript',
      sourceHash: compiled.sourceHash,
      logs,
      referenceId: 'diagnostic.calculation',
      diagnostics: [
        {
          stage: 'execution',
          language: 'javascript',
          code,
          message: problem.message,
          sourceHash: compiled.sourceHash,
          referenceId: 'diagnostic.calculation',
          location: legacy
            ? { file: 'calculation.js', line: legacy.range.startLineNumber, column: legacy.range.startColumn }
            : null,
          ...(legacy ? { file: 'calculation.js', range: legacy.range, sourceLine: legacy.sourceLine } : {}),
        },
      ],
    })
  }
}
