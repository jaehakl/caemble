import { readFile, writeFile } from 'node:fs/promises'
import { evaluateRequest } from './evaluation'

// A disposable, credential-free child. The Python parent owns all transport.
const stdout = process.stdout.write.bind(process.stdout)
console.log = (...values: unknown[]) => process.stderr.write(`${values.map(String).join(' ')}\n`)
process.stdout.write = process.stderr.write.bind(process.stderr)

async function main() {
  process.stdin.setEncoding('utf8')
  let input = ''
  for await (const chunk of process.stdin) input += String(chunk)
  const envelope = JSON.parse(input)
  const request = JSON.parse(await readFile(envelope.input_file, 'utf8'))
  const result = await evaluateRequest(request, __dirname)
  await writeFile(envelope.output_file, JSON.stringify(result), { encoding: 'utf8', flag: 'wx' })
  stdout('{"ok":true}\n')
}

void main().catch((cause: unknown) => {
  const error = cause !== null && typeof cause === 'object' ? cause : new Error(String(cause))
  stdout(`${JSON.stringify({ error: { ...error, message: 'message' in error ? error.message : String(cause) } })}\n`)
  process.exitCode = 1
})
