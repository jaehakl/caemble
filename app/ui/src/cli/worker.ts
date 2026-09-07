import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { prepareCaeMeasurement } from '@/platform/node/build'
import { compileNodeCalculation, runNodeCalculation } from '@/platform/node/calculation'
import type { AuthoringDiagnostic, AuthoringErrorMetadata } from '@/contracts/authoring'

const stdout = process.stdout.write.bind(process.stdout)
console.log = (...values: unknown[]) => {
  process.stderr.write(`${values.map(String).join(' ')}\n`)
}
process.stdout.write = process.stderr.write.bind(process.stderr)
let requestContext: {
  stage: string
  language: AuthoringDiagnostic['language']
  sourceHash?: string
  referenceId: string
} = { stage: 'worker-request', language: 'data', referenceId: 'diagnostic.cli' }
async function main() {
  let input = ''
  for await (const chunk of process.stdin) input += String(chunk)
  const request = JSON.parse(input)
  if (request?.operation === 'build') {
    requestContext = {
      stage: 'build',
      language: 'typescript',
      referenceId: 'diagnostic.experiment',
      ...(typeof request.build?.source_hash === 'string' ? { sourceHash: request.build.source_hash } : {}),
    }
  } else if (request?.operation === 'calculation-check' || request?.operation === 'calculation-run') {
    requestContext = {
      stage: request.operation === 'calculation-check' ? 'compile' : 'input',
      language: 'javascript',
      referenceId: 'diagnostic.calculation',
      ...(typeof request.source === 'string'
        ? { sourceHash: createHash('sha256').update(request.source).digest('hex') }
        : {}),
    }
  }
  let result: unknown
  if (request.operation === 'build') {
    const prepared = await prepareCaeMeasurement(request.build, __dirname)
    await writeFile(
      request.output,
      JSON.stringify({ measurement: prepared.measurement, presentation: prepared.presentation }),
      { encoding: 'utf8', flag: 'wx' },
    )
    result = { warnings: prepared.warnings }
  } else if (request.operation === 'calculation-check') result = await compileNodeCalculation(request.source)
  else if (request.operation === 'calculation-run') {
    const calculationInput = request.input ?? JSON.parse(await readFile(request.inputFile, 'utf8'))
    requestContext.stage = 'execution'
    result = await runNodeCalculation(request.source, calculationInput)
  } else throw new Error('Unknown isolated operation.')
  stdout(`${JSON.stringify(result)}\n`)
}
void main().catch((error: unknown) => {
  // VM errors can come from another realm and fail instanceof Error while retaining their native code/message.
  const problem = (error !== null && typeof error === 'object' ? error : new Error(String(error))) as Partial<Error> &
    AuthoringErrorMetadata
  const message = typeof problem.message === 'string' ? problem.message : String(error)
  const sourceHash = problem.sourceHash ?? requestContext.sourceHash
  const referenceId = problem.referenceId ?? requestContext.referenceId
  const stage = problem.stage ?? requestContext.stage
  const language = problem.language ?? requestContext.language
  const code = problem.code ?? 'worker-operation'
  const diagnostics = (
    problem.diagnostics?.length
      ? problem.diagnostics
      : [{ message, code, stage, language, sourceHash, referenceId, location: null }]
  ).map((diagnostic) => ({
    ...diagnostic,
    sourceHash: diagnostic.sourceHash ?? sourceHash ?? null,
    referenceId: diagnostic.referenceId ?? referenceId,
    location: diagnostic.location ?? null,
  }))
  stdout(
    `${JSON.stringify({
      error: {
        message,
        code,
        stage,
        language,
        sourceHash: sourceHash ?? null,
        referenceId,
        location: diagnostics.find((diagnostic) => diagnostic.location !== null)?.location ?? null,
        diagnostic: problem.diagnostic,
        diagnostics,
        logs: problem.logs,
      },
    })}\n`,
  )
  process.exitCode = 1
})
