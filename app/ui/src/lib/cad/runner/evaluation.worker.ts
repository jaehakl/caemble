/// <reference lib="webworker" />

import { cadSnapshotTransferables } from '../execution/meshValidation'
import { assertEvaluatedDocumentSnapshot, serializeEvaluatedDocumentSnapshot } from '../execution/snapshot'
import { runtimeDiagnostic } from '../execution/runtimeDiagnostics'
import { executeCompiledDocument, inspectCompiledDocument } from '../execution/userModule'
import { CadModelError } from '../model/core'
import {
  assertRunnerOperationEnvelope,
  type RunnerOperationResultEnvelope,
} from './protocol'

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
    } else {
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
    }
  } catch (error) {
    const entrySource = request.compiledDocument.sources['experiment.tsx']
    const diagnostic = error instanceof Error && entrySource ? runtimeDiagnostic(error, entrySource) : undefined
    response = {
      type: request.type === 'inspect' ? 'inspection-error' : 'evaluation-error',
      requestId: request.requestId,
      revision: request.revision,
      documentType: 'experiment',
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
      : [],
  )
}

self.onmessage = (event: MessageEvent<unknown>) => handleOperation(event.data)
self.postMessage({ type: 'runner-worker-ready' })

export {}
