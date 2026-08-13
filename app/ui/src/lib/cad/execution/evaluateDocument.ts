import { compileCadDocument } from '../compiler/monacoCompiler'
import { evaluateInIsolatedRunner, inspectInIsolatedRunner, previewGeometryInIsolatedRunner } from '../runner/client'
import {
  assertCadEvaluationRequest,
  assertCadGeometryPreviewRequest,
  assertCadInspectionRequest,
} from '../runner/protocol'
import {
  EXPERIMENT_SIMULATION_PATH,
  assertCadSourceDocument,
  createCadSourceDocument,
  createExperimentSourceBundle,
  type CadEvaluationInput,
  type ExperimentSourceDocument,
} from '../source/document'
import type { GeometryDraftOverlay, GeometryModuleCoordinate } from '../source/effectiveGeometryGraph'
import type { GeometrySnapshot } from '../source/geometrySnapshot'
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

export type EvaluateDocumentOptions = Readonly<{
  signal?: AbortSignal
  timeoutMs?: 3000 | 10000 | 30000
  geometryDrafts?: GeometryDraftOverlay
}>

export type GeometryModuleEvaluationOptions = Readonly<{
  signal?: AbortSignal
  timeoutMs?: 3000 | 10000 | 30000
  geometryDrafts?: GeometryDraftOverlay
  lengthUnit?: UcumUnit
}>

export type GeometryModulePreview = Readonly<{
  coordinate: GeometryModuleCoordinate
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
  options: EvaluateDocumentOptions = {},
): Promise<CadDocumentInspection> {
  assertCadSourceDocument(document)
  const compiledDocument = await compileCadDocument(document, options)
  const request: CadInspectionRequest = {
    type: 'inspect',
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
  options: EvaluateDocumentOptions = {},
): Promise<EvaluatedExperimentSnapshot> {
  assertCadSourceDocument(input.document)
  const compiledDocument = await compileCadDocument(input.document, options)
  const request: CadEvaluationRequest = {
    type: 'evaluate',
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

const geometryPreviewFiles = Object.freeze({
  'experiment.tsx': `import { experiment } from '@caemble/core'
export default experiment({ lengthUnit: 'mm', varsSchema: {}, geometry: () => null, recordedData: {} })
`,
  'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return None\n',
  'tasks/preview.tsx': `import { defineTask } from '@caemble/core'
export default defineTask({ kernel: { name: 'preview', version: '1.0.0' }, config: () => ({}) })
`,
})

export async function evaluateGeometryModule(
  snapshot: GeometrySnapshot,
  coordinate: GeometryModuleCoordinate,
  exportName: string,
  options: GeometryModuleEvaluationOptions = {},
): Promise<GeometryModulePreview> {
  const files = {
    ...geometryPreviewFiles,
    'geometry.tsx': `import { ${exportName} } from ${JSON.stringify(coordinate)}\nexport { ${exportName} }\n`,
  }
  const document = createCadSourceDocument('experiment', createExperimentSourceBundle(files, snapshot))
  const compiledDocument = await compileCadDocument(document, {
    geometryDrafts: options.geometryDrafts,
  })
  const request: CadGeometryPreviewRequest = {
    type: 'preview-geometry',
    compiledDocument,
    coordinate,
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
            coordinate,
            exportName,
            sourceHash: response.sourceHash,
            scene: deserializeCadScene(response.scene),
          }),
        )
      } else reject(new CadDocumentEvaluationError(response.message, response.diagnostics))
    },
  )
}
