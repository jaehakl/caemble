import type * as Monaco from 'monaco-editor'
import {
  EXPERIMENT_ENTRY_PATH,
  assertCadSourceDocument,
  cadSourceHash,
  experimentTaskPaths,
  type CadSourceDocument,
} from '../source/document'
import { analyzeCadSource, analyzeTaskSource } from '../source/sourceAnalysis'
import { CAD_COMPILER_VERSION, type CadDiagnostic, type CompiledCadDocument, type CompiledCadSource } from './types'

const compilationCache = new Map<string, Promise<CompiledCadDocument>>()
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

function documentSources(document: CadSourceDocument) {
  return Object.fromEntries(
    [EXPERIMENT_ENTRY_PATH, ...experimentTaskPaths(document.sourceBundle)].map((path) => [
      path,
      document.sourceBundle.files[path],
    ]),
  )
}

function assertSourcePolicy(path: string, source: string) {
  if (path === EXPERIMENT_ENTRY_PATH) analyzeCadSource(source)
  else analyzeTaskSource(source)
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

async function compile(document: CadSourceDocument, sourceHash: string): Promise<CompiledCadDocument> {
  const sources = documentSources(document)
  for (const [path, source] of Object.entries(sources)) {
    try {
      assertSourcePolicy(path, source)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new CadCompilationError('policy', message, [
        {
          code: 'CAD_POLICY',
          file: path,
          message,
          phase: 'policy',
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
          severity: 'error',
        },
      ])
    }
  }

  const { loadMonaco } = await import('./monacoRuntime')
  const monaco = await loadMonaco()
  const models = Object.fromEntries(
    Object.entries(sources).map(([path, source]) => {
      const uri = monaco.Uri.parse(`file:///caemble-source/${sourceHash}/${path}`)
      return [path, monaco.editor.createModel(source, 'typescript', uri)]
    }),
  )
  let timeout = 0
  try {
    const compilation = async () => {
      const workerFactory = await getTypeScriptWorker(monaco)
      const compiledEntries = await Promise.all(
        Object.entries(models).map(async ([path, model]) => {
          const worker = await workerFactory(model.uri)
          const [syntactic, semantic] = await Promise.all([
            worker.getSyntacticDiagnostics(model.uri.toString()),
            worker.getSemanticDiagnostics(model.uri.toString()),
          ])
          const diagnostics = [
            ...syntactic.map((diagnostic) => convertDiagnostic(diagnostic, model, path, 'syntax')),
            ...semantic.map((diagnostic) => convertDiagnostic(diagnostic, model, path, 'semantic')),
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
          const output = await worker.getEmitOutput(model.uri.toString())
          const emittedCode = output.outputFiles.find((file) => file.name.endsWith('.js'))?.text
          const sourceMap = output.outputFiles.find((file) => file.name.endsWith('.js.map'))?.text
          if (output.emitSkipped || emittedCode === undefined) {
            throw new CadCompilationError('compile', `TypeScript did not emit JavaScript for ${path}.`, diagnostics)
          }
          const executableCode = emittedCode.replace(/\r?\n\/\/# sourceMappingURL=.*?(?:\r?\n)?$/u, '')
          const compiledSource: CompiledCadSource = Object.freeze({
            apiVersion: 5,
            compilerVersion: CAD_COMPILER_VERSION,
            entryFile: path,
            code: `${executableCode}\n//# sourceURL=caemble://${sourceHash}/${path}`,
            ...(sourceMap === undefined ? {} : { sourceMap }),
            sourceHash,
          })
          return [path, compiledSource] as const
        }),
      )
      return Object.freeze({
        apiVersion: 5 as const,
        compilerVersion: CAD_COMPILER_VERSION,
        sourceHash,
        sources: Object.freeze(Object.fromEntries(compiledEntries)),
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
    Object.values(models).forEach((model) => model.dispose())
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
