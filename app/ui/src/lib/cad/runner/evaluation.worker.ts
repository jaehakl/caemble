/// <reference lib="webworker" />

import { executeCompiledDocument } from '../execution/userModule'
import { assertEvaluatedDocumentSnapshot, serializeEvaluatedDocumentSnapshot } from '../execution/snapshot'
import { cadSnapshotTransferables } from '../execution/meshValidation'
import { runtimeDiagnostic } from '../execution/runtimeDiagnostics'
import { CadModelError } from '../model/core'
import { assertRunnerEvaluationEnvelope, type RunnerEvaluationResultEnvelope } from './protocol'

function handleEvaluation(value: unknown) {
  assertRunnerEvaluationEnvelope(value)
  const { nonce, request } = value
  let response: RunnerEvaluationResultEnvelope['response']
  try {
    const snapshot = serializeEvaluatedDocumentSnapshot(
      executeCompiledDocument(
        request.compiledDocument,
        request.document.kind,
        request.document.realizationSeed,
        request.vars,
        request.document.pythonSource,
      ),
    )
    assertEvaluatedDocumentSnapshot(snapshot)
    response = {
      type: 'evaluation-success',
      requestId: request.requestId,
      revision: request.revision,
      documentType: request.document.kind,
      snapshot,
    }
  } catch (error) {
    const entrySource = request.compiledDocument.sources[`${request.document.kind}.tsx`]
    const diagnostic = error instanceof Error && entrySource ? runtimeDiagnostic(error, entrySource) : undefined
    response = {
      type: 'evaluation-error',
      requestId: request.requestId,
      revision: request.revision,
      documentType: request.document.kind,
      errorType: error instanceof CadModelError ? 'model' : 'runtime',
      message: error instanceof Error ? error.message : String(error),
      ...(diagnostic ? { diagnostics: [diagnostic] } : {}),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    }
  }
  self.postMessage(
    { type: 'evaluation-result', nonce, response },
    response.type === 'evaluation-success'
      ? response.snapshot.kind === 'structure'
        ? cadSnapshotTransferables(response.snapshot.scene)
        : Object.values(response.snapshot.taskScenes).flatMap(cadSnapshotTransferables)
      : [],
  )
}

self.onmessage = (event: MessageEvent<unknown>) => {
  handleEvaluation(event.data)
}

self.postMessage({ type: 'runner-worker-ready' })

export {}
