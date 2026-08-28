import assert from 'node:assert/strict'
import { calculationMonacoStubState } from './calculation-monaco-stub'
import { compileCalculationSource } from '../src/lib/calculation/compiler'

function sourceWithValue(value: number) {
  return `export default function calculate(input: CalculationInput): CalculationOutput {
  void input
  return { dtype: 'float64', shape: [], data: ${value}, axes: [] }
}`
}

async function main() {
  const source = sourceWithValue(0)
  const [first, duplicate] = await Promise.all([compileCalculationSource(source), compileCalculationSource(source)])
  assert.strictEqual(first, duplicate)
  assert.equal(calculationMonacoStubState.emitCount, 1)
  const firstUri = calculationMonacoStubState.modelUris[0]

  for (let value = 1; value <= 33; value += 1) await compileCalculationSource(sourceWithValue(value))
  const emitCountBeforeRetry = calculationMonacoStubState.emitCount
  await compileCalculationSource(source)
  assert.equal(calculationMonacoStubState.emitCount, emitCountBeforeRetry + 1)
  assert.notEqual(calculationMonacoStubState.modelUris.at(-1), firstUri)
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
