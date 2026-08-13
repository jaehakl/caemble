/// <reference lib="webworker" />

import { cadSnapshotTransferables } from '../execution/meshValidation'
import { serializeCadScene } from '../execution/mesh'
import { assertEvaluatedDocumentSnapshot, serializeEvaluatedDocumentSnapshot } from '../execution/snapshot'
import { runtimeDiagnostic } from '../execution/runtimeDiagnostics'
import {
  evaluateCompiledGeometryModule,
  executeCompiledDocument,
  inspectCompiledDocument,
} from '../execution/userModule'
import { CadModelError } from '../model/core'
import { assertRunnerOperationEnvelope, type RunnerOperationResultEnvelope } from './protocol'

function handleOperation(value: unknown) {
  assertRunnerOperationEnvelope(value)
  const { nonce, request, type: operation } = value
  let response: RunnerOperationResultEnvelope['response']
  try {
    if (request.type === 'inspect') {
      const inspection = inspectCompiledDocument(request.compiledDocument)
      response = {
        type: 'inspection-success',
        requestId: request.requestId,
        revision: request.revision,
        documentType: 'experiment',
        sourceHash: request.compiledDocument.sourceHash,
        varsSchema: inspection.varsSchema,
      }
    } else if (request.type === 'evaluate') {
      const snapshot = serializeEvaluatedDocumentSnapshot(
        executeCompiledDocument(request.compiledDocument, request.vars, request.pythonSource),
      )
      assertEvaluatedDocumentSnapshot(snapshot)
      response = {
        type: 'evaluation-success',
        requestId: request.requestId,
        revision: request.revision,
        documentType: 'experiment',
        snapshot,
      }
    } else {
      response = {
        type: 'geometry-preview-success',
        requestId: request.requestId,
        revision: request.revision,
        documentType: 'geometry',
        sourceHash: request.compiledDocument.sourceHash,
        scene: serializeCadScene(
          evaluateCompiledGeometryModule(request.compiledDocument, request.coordinate, request.lengthUnit),
        ),
      }
    }
  } catch (error) {
    const compiledSources = [
      ...Object.values(request.compiledDocument.sources),
      ...Object.values(request.compiledDocument.geometryGraph?.modules ?? {}),
    ]
    const diagnostic =
      error instanceof Error
        ? compiledSources.map((source) => runtimeDiagnostic(error, source)).find(Boolean)
        : undefined
    response = {
      type:
        request.type === 'inspect'
          ? 'inspection-error'
          : request.type === 'evaluate'
            ? 'evaluation-error'
            : 'geometry-preview-error',
      requestId: request.requestId,
      revision: request.revision,
      documentType: request.type === 'preview-geometry' ? 'geometry' : 'experiment',
      errorType: error instanceof CadModelError ? 'model' : 'runtime',
      message: error instanceof Error ? error.message : String(error),
      ...(diagnostic ? { diagnostics: [diagnostic] } : {}),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    }
  }
  const envelope: RunnerOperationResultEnvelope = { type: 'operation-result', operation, nonce, response }
  self.postMessage(
    envelope,
    response.type === 'evaluation-success'
      ? [
          ...cadSnapshotTransferables(response.snapshot.scene),
          ...Object.values(response.snapshot.taskScenes).flatMap(cadSnapshotTransferables),
        ]
      : response.type === 'geometry-preview-success'
        ? cadSnapshotTransferables(response.scene)
        : [],
  )
}

self.onmessage = (event: MessageEvent<unknown>) => handleOperation(event.data)
self.postMessage({ type: 'runner-worker-ready' })

export {}
