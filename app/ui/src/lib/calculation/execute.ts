import { CALCULATION_MATHJS_RUNTIME } from './mathRuntime'
import { calculationIndex } from './indexGuard'
import { CALCULATION_INDEX_GUARD_GLOBAL, CALCULATION_SHADOWED_GLOBAL_NAMES } from './runtimeGlobals'
import { createCalculationConsole } from './log'
import { assertCalculationInput, normalizeCalculationOutput } from './validation'
import type { CompiledCalculationSource, CalculationInput } from './types'

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

export function executeCalculation(
  compiledSource: CompiledCalculationSource,
  input: CalculationInput,
  emitLog: (message: string) => void,
) {
  assertCalculationInput(input)
  input = Object.fromEntries(
    Object.entries(input).map(([path, leaf]) => {
      if (leaf.dtype !== 'complex64') return [path, leaf]
      const complex = (value: unknown) => {
        const { re, im } = value as { re: number; im: number }
        return (CALCULATION_MATHJS_RUNTIME.complex as (re: number, im: number) => { re: number; im: number })(re, im)
      }
      return [path, { ...leaf, data: Array.isArray(leaf.data) ? leaf.data.map(complex) : complex(leaf.data) }]
    }),
  )
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
