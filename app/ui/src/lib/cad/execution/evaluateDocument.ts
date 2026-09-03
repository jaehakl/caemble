import { compileCadDocument } from '../compiler/monacoCompiler'
import {
  evaluateInIsolatedRunner,
  inspectInIsolatedRunner,
  previewGeometryInIsolatedRunner,
} from '@/platform/isolated-runner/client'
import {
  assertCadEvaluationRequest,
  assertCadGeometryPreviewRequest,
  assertCadInspectionRequest,
} from '@/platform/isolated-runner/protocol'
import {
  EXPERIMENT_SIMULATION_PATH,
  type CadEvaluationInput,
  type ExperimentSourceDocument,
  type ExperimentSourceBundle,
} from '../source/document'
import type { UcumUnit } from '../model/units'
import { deserializeCadScene } from './mesh'
import type { CadScene } from '../evaluation/types'
import type {
  CadDiagnostic,
  CadEvaluationRequest,
  CadEvaluationResponse,
  CadInspectionRequest,
  CadInspectionResponse,
  CadGeometryPreviewRequest,
  CadGeometryPreviewResponse,
} from '../worker/protocol'
import type { EvaluatedExperimentSnapshot } from './snapshot'
import type { VarsSchemaEntry } from '../model/vars'
import { installCatalogRuntimeSlice, registerSourceCatalogRuntimeSlice } from '@/lib/catalog/runtime'
import type { CatalogRuntimeSlice } from '@/contracts/catalog'

export type CatalogRuntimeSliceFetcher = (bundle: ExperimentSourceBundle) => Promise<CatalogRuntimeSlice>

type CatalogRuntimeSliceOptions =
  | Readonly<{ catalog: CatalogRuntimeSlice; catalogFetcher?: never }>
  | Readonly<{ catalog?: never; catalogFetcher: CatalogRuntimeSliceFetcher }>

export type EvaluateDocumentOptions = Readonly<{
  signal?: AbortSignal
  timeoutMs?: 3000 | 10000 | 30000
}> &
  CatalogRuntimeSliceOptions

export type GeometryModuleEvaluationOptions = EvaluateDocumentOptions &
  Readonly<{
    lengthUnit?: UcumUnit
  }>

export type GeometryModulePreview = Readonly<{
  path: string
  exportName: string
  sourceHash: string
  scene: CadScene
}>

export type CadDocumentInspection = Readonly<{
  sourceHash: string
  varsSchema: Readonly<Record<string, VarsSchemaEntry>>
}>

export class CadDocumentEvaluationError extends Error {
  readonly diagnostics: readonly CadDiagnostic[]
  constructor(message: string, diagnostics: readonly CadDiagnostic[] = []) {
    super(message)
    this.name = 'CadDocumentEvaluationError'
    this.diagnostics = diagnostics
  }
}

function resolveCatalogRuntimeSlice(bundle: ExperimentSourceBundle, options: CatalogRuntimeSliceOptions) {
  if (options.catalog !== undefined) return Promise.resolve(options.catalog)
  return options.catalogFetcher(bundle)
}

function timeoutPromise<Response, Result>(
  options: EvaluateDocumentOptions,
  run: (callbacks: {
    onFailure: (message: string) => void
    onResponse: (response: Response) => void
    onStart: () => void
  }) => () => void,
  settle: (response: Response, resolve: (value: Result) => void, reject: (reason?: unknown) => void) => void,
) {
  if (options.signal?.aborted) return Promise.reject(new DOMException('The CAD operation was aborted.', 'AbortError'))
  return new Promise<Result>((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 3000
    let settled = false
    let cancel: () => void = () => undefined
    let timeout: number | null = null
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      if (timeout !== null) window.clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      callback()
    }
    const abort = () =>
      finish(() => {
        cancel()
        reject(new DOMException('The CAD operation was aborted.', 'AbortError'))
      })
    options.signal?.addEventListener('abort', abort, { once: true })
    cancel = run({
      onFailure(message) {
        finish(() => reject(new CadDocumentEvaluationError(message)))
      },
      onStart() {
        if (settled) return
        timeout = window.setTimeout(
          () =>
            finish(() => {
              cancel()
              reject(new CadDocumentEvaluationError(`CAD operation timed out after ${timeoutMs / 1000} seconds.`))
            }),
          timeoutMs,
        )
      },
      onResponse(response) {
        finish(() => settle(response, resolve, reject))
      },
    })
  })
}

export async function inspectDocument(
  document: ExperimentSourceDocument,
  options: EvaluateDocumentOptions,
): Promise<CadDocumentInspection> {
  const catalog = await resolveCatalogRuntimeSlice(document.sourceBundle, options)
  installCatalogRuntimeSlice(catalog)
  const compiledDocument = await compileCadDocument(document, {
    catalogRevision: catalog.catalogRevision,
    catalog,
  })
  registerSourceCatalogRuntimeSlice(compiledDocument.sourceHash, catalog)
  const request: CadInspectionRequest = {
    type: 'inspect',
    catalog,
    compiledDocument,
    requestId: `inspect-${crypto.randomUUID()}`,
    revision: 0,
  }
  assertCadInspectionRequest(request)
  return timeoutPromise<CadInspectionResponse, CadDocumentInspection>(
    options,
    (callbacks) => inspectInIsolatedRunner(request, callbacks),
    (response, resolve, reject) => {
      if (response.type === 'inspection-success') {
        resolve(Object.freeze({ sourceHash: response.sourceHash, varsSchema: response.varsSchema }))
      } else reject(new CadDocumentEvaluationError(response.message, response.diagnostics))
    },
  )
}

export async function evaluateDocument(
  input: CadEvaluationInput,
  options: EvaluateDocumentOptions,
): Promise<EvaluatedExperimentSnapshot> {
  const catalog = await resolveCatalogRuntimeSlice(input.document.sourceBundle, options)
  installCatalogRuntimeSlice(catalog)
  const compiledDocument = await compileCadDocument(input.document, {
    catalogRevision: catalog.catalogRevision,
    catalog,
  })
  registerSourceCatalogRuntimeSlice(compiledDocument.sourceHash, catalog)
  const request: CadEvaluationRequest = {
    type: 'evaluate',
    catalog,
    compiledDocument,
    pythonSource: input.document.sourceBundle.files[EXPERIMENT_SIMULATION_PATH],
    requestId: `evaluate-${crypto.randomUUID()}`,
    revision: 0,
    vars: input.vars,
  }
  assertCadEvaluationRequest(request)
  return timeoutPromise<CadEvaluationResponse, EvaluatedExperimentSnapshot>(
    options,
    (callbacks) => evaluateInIsolatedRunner(request, callbacks),
    (response, resolve, reject) => {
      if (response.type === 'evaluation-success') resolve(response.snapshot)
      else reject(new CadDocumentEvaluationError(response.message, response.diagnostics))
    },
  )
}

export async function evaluateGeometryModule(
  document: ExperimentSourceDocument,
  path: string,
  exportName: string,
  options: GeometryModuleEvaluationOptions,
): Promise<GeometryModulePreview> {
  const catalog = await resolveCatalogRuntimeSlice(document.sourceBundle, options)
  const compiledDocument = await compileCadDocument(document, {
    catalogRevision: catalog.catalogRevision,
    catalog,
  })
  const request: CadGeometryPreviewRequest = {
    type: 'preview-geometry',
    catalog,
    compiledDocument,
    path,
    exportName,
    lengthUnit: options.lengthUnit ?? 'mm',
    requestId: `preview-geometry-${crypto.randomUUID()}`,
    revision: 0,
  }
  assertCadGeometryPreviewRequest(request)
  return timeoutPromise<CadGeometryPreviewResponse, GeometryModulePreview>(
    options,
    (callbacks) => previewGeometryInIsolatedRunner(request, callbacks),
    (response, resolve, reject) => {
      if (response.type === 'geometry-preview-success') {
        resolve(
          Object.freeze({
            path,
            exportName,
            sourceHash: response.sourceHash,
            scene: deserializeCadScene(response.scene),
          }),
        )
      } else reject(new CadDocumentEvaluationError(response.message, response.diagnostics))
    },
  )
}
