import { assertCompiledCadSource, type CompiledCadSource } from '../compiler/types'
import { assertEvaluatedDocumentSnapshot } from '../execution/snapshotValidation'
import { assertBuiltRealization, type BuiltSample, type BuiltSetup } from '../execution/realization'
import { CadModelError } from '../model/errors'
import type { CadEvaluationRequest, CadEvaluationResponse } from '../worker/protocol'
import type { SimulationProgress, SimulationResult } from '../../simulation/types'
import { assertSimulationResult } from '../../simulation/validation'

export type RunnerEvaluationEnvelope = Readonly<{
  type: 'evaluate'
  nonce: string
  request: CadEvaluationRequest
}>

export type RunnerEvaluationStartedEnvelope = Readonly<{
  type: 'evaluation-started'
  nonce: string
  requestId: string
  revision: number
  documentType: 'structure' | 'experiment'
}>

export type RunnerEvaluationResultEnvelope = Readonly<{
  type: 'evaluation-result'
  nonce: string
  response: CadEvaluationResponse
}>

export type RunnerCancelEvaluationEnvelope = Readonly<{
  type: 'cancel-evaluation'
  nonce: string
  requestId: string
}>

type SimulationRequestBase = Readonly<{
  requestId: string
  structureRevision: number
  experimentRevision: number
  compiledSource: CompiledCadSource
  sample: BuiltSample
  setup: BuiltSetup
}>

export type SimulationPreflightRequest = SimulationRequestBase &
  Readonly<{
    type: 'preflight-simulation'
  }>

export type SimulationRunRequest = SimulationRequestBase &
  Readonly<{
    type: 'run-simulation'
  }>

export type SimulationRequest = SimulationPreflightRequest | SimulationRunRequest

export type SimulationPreflightIssue = Readonly<{
  path: string
  message: string
  documentType?: 'structure' | 'experiment'
}>

export type SimulationPreflightResponse = Readonly<{
  type: 'preflight-simulation-result'
  requestId: string
  structureRevision: number
  experimentRevision: number
  issues: readonly SimulationPreflightIssue[]
}>

export type SimulationRunResponse =
  | Readonly<{
      type: 'run-simulation-success'
      requestId: string
      structureRevision: number
      experimentRevision: number
      result: SimulationResult
    }>
  | Readonly<{
      type: 'run-simulation-error'
      requestId: string
      structureRevision: number
      experimentRevision: number
      message: string
      stack?: string
    }>

export type RunnerSimulationEnvelope = Readonly<{
  type: SimulationRequest['type']
  nonce: string
  request: SimulationRequest
}>

export type RunnerSimulationStartedEnvelope = Readonly<{
  type: 'simulation-started'
  nonce: string
  requestId: string
  structureRevision: number
  experimentRevision: number
}>

export type RunnerSimulationProgressEnvelope = Readonly<{
  type: 'simulation-progress'
  nonce: string
  requestId: string
  structureRevision: number
  experimentRevision: number
  progress: SimulationProgress
}>

export type RunnerSimulationResultEnvelope = Readonly<{
  type: 'preflight-simulation-result' | 'run-simulation-result'
  nonce: string
  response: SimulationPreflightResponse | SimulationRunResponse
}>

export type RunnerCancelSimulationEnvelope = Readonly<{
  type: 'cancel-simulation'
  nonce: string
  requestId: string
}>

function assertPlainObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new CadModelError(`${path} must be a plain object.`)
  }
}

function assertOnlyKeys(value: object, allowed: readonly string[], path: string) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) throw new CadModelError(`${path}.${unknown} is not allowed.`)
}

function assertNonce(value: unknown) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{16,128}$/.test(value)) {
    throw new CadModelError('Runner message nonce is invalid.')
  }
}

function assertIdentity(requestId: unknown, revision: unknown, path: string) {
  if (
    typeof requestId !== 'string' ||
    requestId.length === 0 ||
    requestId.length > 256 ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 0
  ) {
    throw new CadModelError(`${path} identity is invalid.`)
  }
}

function assertEvaluationVars(vars: unknown) {
  if (vars === undefined) return
  assertPlainObject(vars, 'request.vars')
  if (Object.keys(vars).length > 4096) {
    throw new CadModelError('CAD evaluation vars exceed the key-count limit.')
  }
}

export function assertCadEvaluationRequest(value: unknown): asserts value is CadEvaluationRequest {
  assertPlainObject(value, 'request')
  assertOnlyKeys(value, ['type', 'requestId', 'revision', 'document', 'compiledSource', 'vars'], 'request')
  if (value.type !== 'evaluate') throw new CadModelError('CAD evaluation request type is invalid.')
  assertIdentity(value.requestId, value.revision, 'CAD evaluation request')
  assertPlainObject(value.document, 'request.document')
  assertOnlyKeys(value.document, ['kind', 'realizationSeed'], 'request.document')
  if (
    (value.document.kind !== 'structure' && value.document.kind !== 'experiment') ||
    !Number.isSafeInteger(value.document.realizationSeed) ||
    (value.document.realizationSeed as number) < 0
  ) {
    throw new CadModelError('CAD evaluation request document is invalid.')
  }
  assertCompiledCadSource(value.compiledSource)
  if (value.compiledSource.entryFile !== `${value.document.kind}.tsx`) {
    throw new CadModelError('Compiled CAD source does not match the requested document kind.')
  }
  assertEvaluationVars(value.vars)
}

export function assertRunnerEvaluationEnvelope(value: unknown): asserts value is RunnerEvaluationEnvelope {
  assertPlainObject(value, 'evaluation')
  assertOnlyKeys(value, ['type', 'nonce', 'request'], 'evaluation')
  if (value.type !== 'evaluate') throw new CadModelError('Runner evaluation type is invalid.')
  assertNonce(value.nonce)
  assertCadEvaluationRequest(value.request)
}

export function assertRunnerEvaluationStartedEnvelope(
  value: unknown,
): asserts value is RunnerEvaluationStartedEnvelope {
  assertPlainObject(value, 'evaluationStarted')
  assertOnlyKeys(value, ['type', 'nonce', 'requestId', 'revision', 'documentType'], 'evaluationStarted')
  if (
    value.type !== 'evaluation-started' ||
    (value.documentType !== 'structure' && value.documentType !== 'experiment')
  ) {
    throw new CadModelError('Runner evaluation started envelope is invalid.')
  }
  assertNonce(value.nonce)
  assertIdentity(value.requestId, value.revision, 'Runner evaluation started')
}

export function assertRunnerEvaluationResultEnvelope(value: unknown): asserts value is RunnerEvaluationResultEnvelope {
  assertPlainObject(value, 'evaluationResult')
  assertOnlyKeys(value, ['type', 'nonce', 'response'], 'evaluationResult')
  if (value.type !== 'evaluation-result') throw new CadModelError('Runner evaluation result type is invalid.')
  assertNonce(value.nonce)
  assertPlainObject(value.response, 'evaluationResult.response')
  const response = value.response
  assertIdentity(response.requestId, response.revision, 'Runner evaluation result')
  if (response.documentType !== 'structure' && response.documentType !== 'experiment') {
    throw new CadModelError('Runner evaluation result document type is invalid.')
  }
  if (response.type === 'evaluation-success') {
    assertOnlyKeys(response, ['type', 'requestId', 'revision', 'documentType', 'snapshot'], 'evaluationResult.response')
    assertEvaluatedDocumentSnapshot(response.snapshot)
    if (response.snapshot.kind !== response.documentType) {
      throw new CadModelError('Runner evaluation snapshot kind does not match the response.')
    }
    return
  }
  if (
    response.type !== 'evaluation-error' ||
    !['compile', 'type', 'policy', 'runtime', 'model'].includes(String(response.errorType)) ||
    typeof response.message !== 'string' ||
    response.message.length > 65_536 ||
    (response.stack !== undefined && typeof response.stack !== 'string') ||
    (response.diagnostics !== undefined && !Array.isArray(response.diagnostics))
  ) {
    throw new CadModelError('Runner evaluation error response is invalid.')
  }
  assertOnlyKeys(
    response,
    ['type', 'requestId', 'revision', 'documentType', 'errorType', 'message', 'diagnostics', 'stack'],
    'evaluationResult.response',
  )
}

function assertSimulationRequest(value: unknown): asserts value is SimulationRequest {
  assertPlainObject(value, 'simulation.request')
  assertOnlyKeys(
    value,
    ['type', 'requestId', 'structureRevision', 'experimentRevision', 'compiledSource', 'sample', 'setup'],
    'simulation.request',
  )
  if (value.type !== 'preflight-simulation' && value.type !== 'run-simulation') {
    throw new CadModelError('Simulation request type is invalid.')
  }
  assertIdentity(value.requestId, value.structureRevision, 'Simulation request structure')
  assertIdentity(value.requestId, value.experimentRevision, 'Simulation request experiment')
  assertCompiledCadSource(value.compiledSource)
  assertBuiltRealization(value.sample)
  assertBuiltRealization(value.setup)
  if (value.sample.kind !== 'sample' || value.setup.kind !== 'setup') {
    throw new CadModelError('Simulation requires a Sample and Setup.')
  }
  if (
    value.compiledSource.entryFile !== 'experiment.tsx' ||
    value.setup.experiment.sourceHash !== value.compiledSource.sourceHash
  ) {
    throw new CadModelError('Simulation Experiment source does not match its compiled source.')
  }
}

export function assertRunnerSimulationEnvelope(value: unknown): asserts value is RunnerSimulationEnvelope {
  assertPlainObject(value, 'simulation')
  assertOnlyKeys(value, ['type', 'nonce', 'request'], 'simulation')
  if (value.type !== 'preflight-simulation' && value.type !== 'run-simulation') {
    throw new CadModelError('Runner simulation type is invalid.')
  }
  assertNonce(value.nonce)
  assertSimulationRequest(value.request)
  if (value.type !== value.request.type) {
    throw new CadModelError('Runner simulation envelope and request types do not match.')
  }
}

export function assertRunnerSimulationStartedEnvelope(
  value: unknown,
): asserts value is RunnerSimulationStartedEnvelope {
  assertPlainObject(value, 'simulationStarted')
  assertOnlyKeys(value, ['type', 'nonce', 'requestId', 'structureRevision', 'experimentRevision'], 'simulationStarted')
  if (value.type !== 'simulation-started') {
    throw new CadModelError('Runner simulation started type is invalid.')
  }
  assertNonce(value.nonce)
  assertIdentity(value.requestId, value.structureRevision, 'Simulation started structure')
  assertIdentity(value.requestId, value.experimentRevision, 'Simulation started experiment')
}

export function assertRunnerSimulationProgressEnvelope(
  value: unknown,
): asserts value is RunnerSimulationProgressEnvelope {
  assertPlainObject(value, 'simulationProgress')
  assertOnlyKeys(
    value,
    ['type', 'nonce', 'requestId', 'structureRevision', 'experimentRevision', 'progress'],
    'simulationProgress',
  )
  if (value.type !== 'simulation-progress') {
    throw new CadModelError('Runner simulation progress type is invalid.')
  }
  assertNonce(value.nonce)
  assertIdentity(value.requestId, value.structureRevision, 'Simulation progress structure')
  assertIdentity(value.requestId, value.experimentRevision, 'Simulation progress experiment')
  assertPlainObject(value.progress, 'simulationProgress.progress')
  assertOnlyKeys(
    value.progress,
    ['runId', 'task', 'kernel', 'stage', 'completed', 'total', 'message'],
    'simulationProgress.progress',
  )
  assertPlainObject(value.progress.kernel, 'simulationProgress.progress.kernel')
  assertOnlyKeys(value.progress.kernel, ['name', 'version'], 'simulationProgress.progress.kernel')
  if (
    value.progress.runId !== value.requestId ||
    typeof value.progress.task !== 'string' ||
    !value.progress.task.trim() ||
    typeof value.progress.kernel.name !== 'string' ||
    !value.progress.kernel.name.trim() ||
    typeof value.progress.kernel.version !== 'string' ||
    !value.progress.kernel.version.trim() ||
    typeof value.progress.stage !== 'string' ||
    !value.progress.stage.trim() ||
    typeof value.progress.completed !== 'number' ||
    !Number.isFinite(value.progress.completed) ||
    value.progress.completed < 0 ||
    (value.progress.total !== undefined &&
      (typeof value.progress.total !== 'number' ||
        !Number.isFinite(value.progress.total) ||
        value.progress.total < value.progress.completed)) ||
    (value.progress.message !== undefined && typeof value.progress.message !== 'string')
  ) {
    throw new CadModelError('Runner simulation progress payload is invalid.')
  }
}

function assertPreflightIssues(value: unknown): asserts value is readonly SimulationPreflightIssue[] {
  if (!Array.isArray(value)) throw new CadModelError('Simulation preflight issues must be an array.')
  value.forEach((issue, index) => {
    assertPlainObject(issue, `simulationResult.response.issues[${index}]`)
    assertOnlyKeys(issue, ['path', 'message', 'documentType'], `simulationResult.response.issues[${index}]`)
    if (
      typeof issue.path !== 'string' ||
      typeof issue.message !== 'string' ||
      (issue.documentType !== undefined && issue.documentType !== 'structure' && issue.documentType !== 'experiment')
    ) {
      throw new CadModelError(`Simulation preflight issue ${index} is invalid.`)
    }
  })
}

export function assertRunnerSimulationResultEnvelope(value: unknown): asserts value is RunnerSimulationResultEnvelope {
  assertPlainObject(value, 'simulationResult')
  assertOnlyKeys(value, ['type', 'nonce', 'response'], 'simulationResult')
  if (value.type !== 'preflight-simulation-result' && value.type !== 'run-simulation-result') {
    throw new CadModelError('Runner simulation result type is invalid.')
  }
  assertNonce(value.nonce)
  assertPlainObject(value.response, 'simulationResult.response')
  const response = value.response
  assertIdentity(response.requestId, response.structureRevision, 'Simulation result structure')
  assertIdentity(response.requestId, response.experimentRevision, 'Simulation result experiment')
  if (response.type === 'preflight-simulation-result') {
    if (value.type !== response.type) throw new CadModelError('Simulation preflight envelope type is invalid.')
    assertOnlyKeys(
      response,
      ['type', 'requestId', 'structureRevision', 'experimentRevision', 'issues'],
      'simulationResult.response',
    )
    assertPreflightIssues(response.issues)
    return
  }
  if (value.type !== 'run-simulation-result') {
    throw new CadModelError('Simulation run envelope type is invalid.')
  }
  if (response.type === 'run-simulation-success') {
    assertOnlyKeys(
      response,
      ['type', 'requestId', 'structureRevision', 'experimentRevision', 'result'],
      'simulationResult.response',
    )
    assertSimulationResult(response.result)
    if (response.result.runId !== response.requestId) {
      throw new CadModelError('Simulation result runId does not match its request.')
    }
    return
  }
  if (
    response.type !== 'run-simulation-error' ||
    typeof response.message !== 'string' ||
    response.message.length > 65_536 ||
    (response.stack !== undefined && typeof response.stack !== 'string')
  ) {
    throw new CadModelError('Simulation run error response is invalid.')
  }
  assertOnlyKeys(
    response,
    ['type', 'requestId', 'structureRevision', 'experimentRevision', 'message', 'stack'],
    'simulationResult.response',
  )
}

export function assertRunnerCancelEvaluationEnvelope(value: unknown): asserts value is RunnerCancelEvaluationEnvelope {
  assertPlainObject(value, 'cancelEvaluation')
  assertOnlyKeys(value, ['type', 'nonce', 'requestId'], 'cancelEvaluation')
  if (value.type !== 'cancel-evaluation' || typeof value.requestId !== 'string' || !value.requestId) {
    throw new CadModelError('Runner evaluation cancellation is invalid.')
  }
  assertNonce(value.nonce)
}

export function assertRunnerCancelSimulationEnvelope(value: unknown): asserts value is RunnerCancelSimulationEnvelope {
  assertPlainObject(value, 'cancelSimulation')
  assertOnlyKeys(value, ['type', 'nonce', 'requestId'], 'cancelSimulation')
  if (value.type !== 'cancel-simulation' || typeof value.requestId !== 'string' || !value.requestId) {
    throw new CadModelError('Runner simulation cancellation is invalid.')
  }
  assertNonce(value.nonce)
}
