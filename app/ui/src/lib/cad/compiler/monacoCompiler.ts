import type * as Monaco from 'monaco-editor'
import {
  EXPERIMENT_ENTRY_PATH,
  EXPERIMENT_GEOMETRY_PATH,
  EXPERIMENT_MATERIAL_PATH,
  assertCadSourceDocument,
  cadSourceHash,
  experimentTaskPaths,
  type CadSourceDocument,
} from '../source/document'
import {
  createEffectiveGeometryGraph,
  type EffectiveGeometryGraph,
  type GeometryDraftOverlay,
} from '../source/effectiveGeometryGraph'
import { analyzeCadSource, analyzeGeometrySource, analyzeMaterialSource, analyzeTaskSource } from '../source/sourceAnalysis'
import {
  CAD_COMPILER_VERSION,
  type CadDiagnostic,
  type CompiledCadDocument,
  type CompiledCadSource,
  type CompiledGeometryModule,
} from './types'
import { withGeometryTypeEnvironment } from './geometryTypeEnvironment'
import { withCatalogTypeEnvironment } from './catalogTypeEnvironment'
import type { CatalogRuntimeSlice } from '@/contracts/catalog'

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
    [
      EXPERIMENT_ENTRY_PATH,
      EXPERIMENT_GEOMETRY_PATH,
      EXPERIMENT_MATERIAL_PATH,
      ...experimentTaskPaths(document.sourceBundle),
    ].map((path) => [path, document.sourceBundle.files[path]]),
  )
}

function assertSourcePolicy(path: string, source: string) {
  if (path === EXPERIMENT_ENTRY_PATH) analyzeCadSource(source)
  else if (path === EXPERIMENT_GEOMETRY_PATH) analyzeGeometrySource(source, { allowEmpty: true, allowLocal: true })
  else if (path === EXPERIMENT_MATERIAL_PATH) analyzeMaterialSource(source)
  else analyzeTaskSource(source)
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
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

async function compile(
  document: CadSourceDocument,
  sourceHash: string,
  geometryGraph: EffectiveGeometryGraph | undefined,
  catalog: CatalogRuntimeSlice | undefined,
): Promise<CompiledCadDocument> {
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
  for (const module of geometryGraph?.modules ?? []) {
    try {
      analyzeGeometrySource(module.source, { allowLocal: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new CadCompilationError('policy', message, [
        {
          code: 'GEOMETRY_POLICY',
          file: module.coordinate,
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
  const sourceModels = Object.fromEntries(
    Object.entries(sources).map(([path, source]) => {
      const uri = monaco.Uri.parse(`file:///caemble-source/${sourceHash}/${path}`)
      return [path, monaco.editor.createModel(source, 'typescript', uri)]
    }),
  )
  const geometryModels = Object.fromEntries(
    (geometryGraph?.modules ?? []).map((module) => {
      const uri = monaco.Uri.parse(
        `file:///caemble-source/${sourceHash}/geometries/${encodeURIComponent(module.coordinate)}.tsx`,
      )
      return [module.coordinate, monaco.editor.createModel(module.source, 'typescript', uri)]
    }),
  )
  let timeout = 0
  try {
    const compilation = async () => {
      const workerFactory = await getTypeScriptWorker(monaco)
      const emitModel = async (model: Monaco.editor.ITextModel, file: string) => {
        const worker = await workerFactory(model.uri)
        const [syntactic, semantic] = await Promise.all([
          worker.getSyntacticDiagnostics(model.uri.toString()),
          worker.getSemanticDiagnostics(model.uri.toString()),
        ])
        const diagnostics = [
          ...syntactic.map((diagnostic) => convertDiagnostic(diagnostic, model, file, 'syntax')),
          ...semantic.map((diagnostic) => convertDiagnostic(diagnostic, model, file, 'semantic')),
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
        const code = output.outputFiles.find((item) => item.name.endsWith('.js'))?.text
        const sourceMap = output.outputFiles.find((item) => item.name.endsWith('.js.map'))?.text
        if (output.emitSkipped || code === undefined) {
          throw new CadCompilationError('compile', `TypeScript did not emit JavaScript for ${file}.`, diagnostics)
        }
        return { code: code.replace(/\r?\n\/\/# sourceMappingURL=.*?(?:\r?\n)?$/u, ''), sourceMap }
      }
      const mutableCompiledGeometryEntries: (readonly [string, CompiledGeometryModule])[] = []
      for (const [coordinate, model] of Object.entries(geometryModels)) {
        mutableCompiledGeometryEntries.push(
          await withGeometryTypeEnvironment(monaco, geometryGraph, async () => {
            const emitted = await emitModel(model, coordinate)
            const graphModule = geometryGraph!.modules.find((item) => item.coordinate === coordinate)!
            const compiledModule: CompiledGeometryModule = Object.freeze({
              apiVersion: 6,
              compilerVersion: CAD_COMPILER_VERSION,
              entryFile: graphModule.coordinate,
              code: `${emitted.code}\n//# sourceURL=caemble://${sourceHash}/geometry/${encodeURIComponent(coordinate)}`,
              ...(emitted.sourceMap === undefined ? {} : { sourceMap: emitted.sourceMap }),
              sourceHash,
              geometrySourceHash: graphModule.sourceHash,
              moduleHash: graphModule.moduleHash,
              exports: graphModule.exports,
              imports: graphModule.imports,
            })
            return [coordinate, compiledModule] as const
          }),
        )
      }
      const compiledEntries = await withCatalogTypeEnvironment(monaco, catalog, () =>
        withGeometryTypeEnvironment(monaco, geometryGraph, async () =>
          Promise.all(
            Object.entries(sourceModels).map(async ([path, model]) => {
              const emitted = await emitModel(model, path)
              const compiledSource: CompiledCadSource = Object.freeze({
                apiVersion: 6,
                compilerVersion: CAD_COMPILER_VERSION,
                entryFile: path,
                code: `${emitted.code}\n//# sourceURL=caemble://${sourceHash}/${path}`,
                ...(emitted.sourceMap === undefined ? {} : { sourceMap: emitted.sourceMap }),
                sourceHash,
              })
              return [path, compiledSource] as const
            }),
          ),
        ),
      )
      return Object.freeze({
        apiVersion: 6 as const,
        compilerVersion: CAD_COMPILER_VERSION,
        sourceHash,
        sources: Object.freeze(Object.fromEntries(compiledEntries)),
        ...(geometryGraph === undefined
          ? {}
          : {
              geometryGraph: Object.freeze({
                graphHash: geometryGraph.graphHash,
                entryImports: geometryGraph.entryImports,
                modules: Object.freeze(Object.fromEntries(mutableCompiledGeometryEntries)),
              }),
            }),
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
    Object.values(sourceModels).forEach((model) => model.dispose())
    Object.values(geometryModels).forEach((model) => model.dispose())
  }
}

export type CompileCadDocumentOptions = Readonly<{
  geometryDrafts?: GeometryDraftOverlay
  catalogRevision?: string
  catalog?: CatalogRuntimeSlice
}>

export async function compileCadDocument(document: CadSourceDocument, options: CompileCadDocumentOptions = {}) {
  assertCadSourceDocument(document)
  const persistedSourceHash = await cadSourceHash(document)
  const geometryGraph = await createEffectiveGeometryGraph(
    document.sourceBundle.geometrySnapshot,
    options.geometryDrafts,
    document.sourceBundle.files[EXPERIMENT_GEOMETRY_PATH],
  )
  const sourceHash =
    Object.keys(options.geometryDrafts ?? {}).length > 0
      ? await sha256(JSON.stringify({ persistedSourceHash, geometryGraphHash: geometryGraph?.graphHash }))
      : persistedSourceHash
  const cacheKey = `${CAD_COMPILER_VERSION}:${options.catalogRevision ?? 'geometry-only'}:${sourceHash}`
  let cached = compilationCache.get(cacheKey)
  if (!cached) {
    cached = compile(document, sourceHash, geometryGraph, options.catalog).catch((error) => {
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
