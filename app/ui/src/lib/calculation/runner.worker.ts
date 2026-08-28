/// <reference lib="webworker" />

import { CALCULATION_MATHJS_RUNTIME } from './mathRuntime'
import {
  assertCalculationRunnerOperationEnvelope,
  type CalculationRunnerOperationEnvelope,
  type CalculationRunnerResultEnvelope,
} from './protocol'
import { calculationIndex } from './indexGuard'
import { CALCULATION_INDEX_GUARD_GLOBAL, CALCULATION_SHADOWED_GLOBAL_NAMES } from './runtimeGlobals'
import { createCalculationConsole } from './log'
import { assertCalculationInput, normalizeCalculationOutput } from './validation'
import { CalculationExecutionError } from './types'

function freezeInput(value: unknown): void {
  if (typeof value !== 'object' || value === null) return
  Object.values(value).forEach(freezeInput)
  if (!Object.isFrozen(value)) Object.freeze(value)
}

const deterministicMath = Object.freeze(
  Object.fromEntries(
    Object.getOwnPropertyNames(Math)
      .filter((name) => name !== 'random')
      .map((name) => [name, (Math as unknown as Record<string, unknown>)[name]]),
  ),
)

function executeCalculation(envelope: CalculationRunnerOperationEnvelope, emitLog: (message: string) => void) {
  const { compiledSource, input } = envelope.request
  assertCalculationInput(input)
  freezeInput(input)
  const module = { exports: {} as Record<string, unknown> }
  const requireMathJs = (specifier: string) => {
    if (specifier !== 'mathjs') throw new Error(`Calculation import is not available: ${specifier}`)
    return CALCULATION_MATHJS_RUNTIME
  }
  const createRunner = new Function(
    'eval',
    `return function(module, exports, require, Math, ${CALCULATION_INDEX_GUARD_GLOBAL}, ${CALCULATION_SHADOWED_GLOBAL_NAMES.join(', ')}) {
      "use strict";
      ${compiledSource.code}
      return module.exports;
    }`,
  )
  const runModule = createRunner(undefined) as (...parameters: unknown[]) => Record<string, unknown>
  const calculationConsole = createCalculationConsole(emitLog)
  runModule(
    module,
    module.exports,
    requireMathJs,
    deterministicMath,
    calculationIndex,
    ...CALCULATION_SHADOWED_GLOBAL_NAMES.map((name) => (name === 'console' ? calculationConsole : undefined)),
  )
  const calculate = module.exports.default
  if (typeof calculate !== 'function') throw new Error('Compiled Calculation has no default function.')
  return normalizeCalculationOutput(calculate(input))
}

function handleOperation(value: unknown) {
  assertCalculationRunnerOperationEnvelope(value)
  const { nonce, request } = value
  let logSequence = 0
  const emitLog = (message: string) => {
    logSequence += 1
    self.postMessage({
      type: 'operation-log',
      operation: 'calculate',
      nonce,
      requestId: request.requestId,
      revision: request.revision,
      sourceHash: request.compiledSource.sourceHash,
      sequence: logSequence,
      message,
    })
  }
  let response: CalculationRunnerResultEnvelope['response']
  try {
    response = {
      type: 'calculation-success',
      requestId: request.requestId,
      revision: request.revision,
      sourceHash: request.compiledSource.sourceHash,
      output: executeCalculation(value, emitLog),
    }
  } catch (error) {
    response = {
      type: 'calculation-error',
      requestId: request.requestId,
      revision: request.revision,
      sourceHash: request.compiledSource.sourceHash,
      errorCode: error instanceof CalculationExecutionError ? error.code : 'runtime',
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof CalculationExecutionError && error.diagnostic ? { diagnostic: error.diagnostic } : {}),
    }
  }
  const envelope: CalculationRunnerResultEnvelope = {
    type: 'operation-result',
    operation: 'calculate',
    nonce,
    response,
  }
  self.postMessage(envelope)
}

self.onmessage = (event: MessageEvent<unknown>) => handleOperation(event.data)
self.postMessage({ type: 'runner-worker-ready' })

export {}
