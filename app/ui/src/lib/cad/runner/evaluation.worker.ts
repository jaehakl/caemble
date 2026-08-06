/// <reference lib="webworker" />

import { executeCompiledSource, loadCompiledSource } from '../execution/userModule'
import { assertEvaluatedDocumentSnapshot, serializeEvaluatedDocumentSnapshot } from '../execution/snapshot'
import { cadSnapshotTransferables } from '../execution/meshValidation'
import { runtimeDiagnostic } from '../execution/runtimeDiagnostics'
import { CadModelError } from '../model/core'
import { ExperimentDefinition } from '../model/v3'
import { KernelRegistry, kernelModules, preflightSimulation, runSimulationProgram } from '../../simulation'
import {
  assertRunnerCancelSimulationEnvelope,
  assertRunnerEvaluationEnvelope,
  assertRunnerSimulationEnvelope,
  type RunnerEvaluationResultEnvelope,
  type RunnerSimulationEnvelope,
} from './protocol'

let activeSimulation: Readonly<{
  abortController: AbortController
  nonce: string
  requestId: string
}> | null = null

function handleEvaluation(value: unknown) {
  assertRunnerEvaluationEnvelope(value)
  const { nonce, request } = value
  let response: RunnerEvaluationResultEnvelope['response']
  try {
    const snapshot = serializeEvaluatedDocumentSnapshot(
      executeCompiledSource(
        request.compiledSource,
        request.document.kind,
        request.document.realizationSeed,
        request.vars,
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
    const diagnostic = error instanceof Error ? runtimeDiagnostic(error, request.compiledSource) : undefined
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
    response.type === 'evaluation-success' ? cadSnapshotTransferables(response.snapshot.scene) : [],
  )
}

function programForSimulation(envelope: RunnerSimulationEnvelope) {
  const { request } = envelope
  const entry = loadCompiledSource(request.compiledSource, 'experiment')
  if (!(entry instanceof ExperimentDefinition)) {
    throw new CadModelError('Simulation requires an Experiment imported from @caemble/core.')
  }
  return entry.createProgramRuntime(request.setup.experiment.variables, request.compiledSource.sourceHash)
}

async function handleSimulation(envelope: RunnerSimulationEnvelope) {
  const { nonce, request } = envelope
  if (activeSimulation) throw new Error('The Simulation Worker is already running.')
  const abortController = new AbortController()
  activeSimulation = Object.freeze({
    abortController,
    nonce,
    requestId: request.requestId,
  })
  try {
    const definition = programForSimulation(envelope)
    const registry = new KernelRegistry(kernelModules)
    if (request.type === 'preflight-simulation') {
      const result = await preflightSimulation(definition, request.sample, request.setup, registry)
      self.postMessage({
        type: 'preflight-simulation-result',
        nonce,
        response: {
          type: 'preflight-simulation-result',
          requestId: request.requestId,
          structureRevision: request.structureRevision,
          experimentRevision: request.experimentRevision,
          issues: result.issues.map((issue) => ({
            documentType: 'experiment',
            path: issue.task ? `tasks.${issue.task}` : 'simulation',
            message: issue.message,
          })),
        },
      })
      return
    }

    const result = await runSimulationProgram(
      definition,
      request.sample,
      request.setup,
      registry,
      abortController.signal,
      request.requestId,
      {
        reportProgress(progress) {
          self.postMessage({
            type: 'simulation-progress',
            nonce,
            requestId: request.requestId,
            structureRevision: request.structureRevision,
            experimentRevision: request.experimentRevision,
            progress,
          })
        },
      },
    )
    self.postMessage({
      type: 'run-simulation-result',
      nonce,
      response: {
        type: 'run-simulation-success',
        requestId: request.requestId,
        structureRevision: request.structureRevision,
        experimentRevision: request.experimentRevision,
        result,
      },
    })
  } catch (error) {
    if (request.type === 'preflight-simulation') {
      self.postMessage({
        type: 'preflight-simulation-result',
        nonce,
        response: {
          type: 'preflight-simulation-result',
          requestId: request.requestId,
          structureRevision: request.structureRevision,
          experimentRevision: request.experimentRevision,
          issues: [
            {
              documentType: 'experiment',
              path: 'simulation',
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        },
      })
      return
    }
    self.postMessage({
      type: 'run-simulation-result',
      nonce,
      response: {
        type: 'run-simulation-error',
        requestId: request.requestId,
        structureRevision: request.structureRevision,
        experimentRevision: request.experimentRevision,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      },
    })
  } finally {
    activeSimulation = null
  }
}

self.onmessage = (event: MessageEvent<unknown>) => {
  if (
    typeof event.data === 'object' &&
    event.data !== null &&
    'type' in event.data &&
    event.data.type === 'cancel-simulation'
  ) {
    try {
      assertRunnerCancelSimulationEnvelope(event.data)
      if (
        activeSimulation &&
        event.data.nonce === activeSimulation.nonce &&
        event.data.requestId === activeSimulation.requestId
      ) {
        activeSimulation.abortController.abort()
      }
    } catch {
      // Invalid cancellation messages cannot affect the active simulation.
    }
    return
  }

  if (
    typeof event.data === 'object' &&
    event.data !== null &&
    'type' in event.data &&
    (event.data.type === 'preflight-simulation' || event.data.type === 'run-simulation')
  ) {
    assertRunnerSimulationEnvelope(event.data)
    void handleSimulation(event.data)
    return
  }

  handleEvaluation(event.data)
}

self.postMessage({ type: 'runner-worker-ready' })

export {}
