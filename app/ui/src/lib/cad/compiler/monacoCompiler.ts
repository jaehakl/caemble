import type * as Monaco from 'monaco-editor'
import { assertCadSourceDocument, cadSourceHash, type CadSourceDocument } from '../source/document'
import { analyzeCadSource } from '../source/sourceAnalysis'
import { CAD_COMPILER_VERSION, type CadDiagnostic, type CompiledCadSource } from './types'

const compilationCache = new Map<string, Promise<CompiledCadSource>>()
const maximumCompilationCacheEntries = 32
const compilationTimeoutMs = 15_000

export class CadCompilationError extends Error {
  readonly diagnostics: readonly CadDiagnostic[]
  readonly errorType: 'compile' | 'policy' | 'type'

  constructor(errorType: 'compile' | 'policy' | 'type', message: string, diagnostics: readonly CadDiagnostic[] = []) {
    super(message)
    this.name = 'CadCompilationError'
    this.errorType = errorType
    this.diagnostics = diagnostics
  }
}

function assertSourcePolicy(document: CadSourceDocument) {
  analyzeCadSource(document.source, document.kind)
}

function diagnosticMessage(message: string | { messageText: string; next?: readonly unknown[] }): string {
  if (typeof message === 'string') return message
  const children =
    message.next?.flatMap((child) =>
      child && typeof child === 'object' && 'messageText' in child
        ? [diagnosticMessage(child as { messageText: string; next?: readonly unknown[] })]
        : [],
    ) ?? []
  return [message.messageText, ...children].join('\n')
}

function convertDiagnostic(
  diagnostic: Monaco.typescript.Diagnostic,
  model: Monaco.editor.ITextModel,
  file: string,
  phase: 'semantic' | 'syntax',
): CadDiagnostic {
  const start = Math.max(0, diagnostic.start ?? 0)
  const end = start + Math.max(0, diagnostic.length ?? 0)
  const startPosition = model.getPositionAt(start)
  const endPosition = model.getPositionAt(end)
  return Object.freeze({
    code: diagnostic.code,
    file,
    message: diagnosticMessage(diagnostic.messageText),
    phase,
    range: Object.freeze({
      startLineNumber: startPosition.lineNumber,
      startColumn: startPosition.column,
      endLineNumber: endPosition.lineNumber,
      endColumn: endPosition.column,
    }),
    severity:
      diagnostic.category === 1
        ? ('error' as const)
        : diagnostic.category === 0
          ? ('warning' as const)
          : ('info' as const),
  })
}

async function getTypeScriptWorker(monaco: typeof Monaco) {
  let registrationError: unknown
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await monaco.typescript.getTypeScriptWorker()
    } catch (error) {
      if (!String(error).includes('TypeScript not registered')) throw error
      registrationError = error
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    }
  }
  throw registrationError
}

async function compile(document: CadSourceDocument, sourceHash: string): Promise<CompiledCadSource> {
  const entryFile = `${document.kind}.tsx` as const
  try {
    assertSourcePolicy(document)
  } catch (error) {
    if (error instanceof CadCompilationError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new CadCompilationError('policy', message, [
      {
        code: 'CAD_POLICY',
        file: entryFile,
        message,
        phase: 'policy',
        range: {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 1,
        },
        severity: 'error',
      },
    ])
  }

  const { loadMonaco } = await import('./monacoRuntime')
  const monaco = await loadMonaco()
  const uri = monaco.Uri.parse(`file:///caemble-source/${sourceHash}/${entryFile}`)
  const model = monaco.editor.createModel(document.source, 'typescript', uri)

  let timeout = 0
  try {
    const compilation = async () => {
      const workerFactory = await getTypeScriptWorker(monaco)
      const worker = await workerFactory(uri)
      const [syntactic, semantic] = await Promise.all([
        worker.getSyntacticDiagnostics(uri.toString()),
        worker.getSemanticDiagnostics(uri.toString()),
      ])
      const diagnostics = [
        ...syntactic.map((diagnostic) => convertDiagnostic(diagnostic, model, entryFile, 'syntax')),
        ...semantic.map((diagnostic) => convertDiagnostic(diagnostic, model, entryFile, 'semantic')),
      ]
      const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
      if (errors.length > 0) {
        throw new CadCompilationError(
          'type',
          errors
            .map(
              (diagnostic) =>
                `${diagnostic.file}:${diagnostic.range.startLineNumber}:${diagnostic.range.startColumn} ${diagnostic.message}`,
            )
            .join('\n'),
          diagnostics,
        )
      }

      const output = await worker.getEmitOutput(uri.toString())
      const emittedCode = output.outputFiles.find((file) => file.name.endsWith('.js'))?.text
      const sourceMap = output.outputFiles.find((file) => file.name.endsWith('.js.map'))?.text
      if (output.emitSkipped || emittedCode === undefined) {
        throw new CadCompilationError('compile', `TypeScript did not emit JavaScript for ${entryFile}.`, diagnostics)
      }
      const executableCode = emittedCode.replace(/\r?\n\/\/# sourceMappingURL=.*?(?:\r?\n)?$/, '')
      return Object.freeze({
        apiVersion: 3 as const,
        compilerVersion: CAD_COMPILER_VERSION,
        entryFile,
        code: `${executableCode}\n//# sourceURL=caemble://${sourceHash}/${entryFile}`,
        ...(sourceMap === undefined ? {} : { sourceMap }),
        sourceHash,
      })
    }

    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = window.setTimeout(() => {
        reject(new CadCompilationError('compile', 'TypeScript compilation timed out after 15 seconds.'))
      }, compilationTimeoutMs)
    })
    return await Promise.race([compilation(), timedOut])
  } finally {
    window.clearTimeout(timeout)
    model.dispose()
  }
}

export async function compileCadDocument(document: CadSourceDocument) {
  assertCadSourceDocument(document)
  const sourceHash = await cadSourceHash(document)
  const cacheKey = `${CAD_COMPILER_VERSION}:${sourceHash}`
  let cached = compilationCache.get(cacheKey)
  if (!cached) {
    cached = compile(document, sourceHash).catch((error) => {
      compilationCache.delete(cacheKey)
      throw error
    })
    compilationCache.set(cacheKey, cached)
    if (compilationCache.size > maximumCompilationCacheEntries) {
      compilationCache.delete(compilationCache.keys().next().value!)
    }
  }
  return cached
}
