import type { File } from '@babel/types'
import type * as Monaco from 'monaco-editor'
import { loadMonaco } from '@/lib/cad/compiler/monacoRuntime'
import { CALCULATION_MONACO_DECLARATION } from './declarations'
import { transformCalculationSource } from './transform'
import { analyzeCalculationSource } from './sourcePolicy'
import { CalculationExecutionError, type CompiledCalculationSource } from './types'

const compilationCache = new Map<string, Promise<CompiledCalculationSource>>()

async function sourceHash(source: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function diagnosticMessage(message: string | { messageText: string; next?: readonly unknown[] }): string {
  if (typeof message === 'string') return message
  const children =
    message.next?.flatMap((child) =>
      child && typeof child === 'object' && 'messageText' in child
        ? [diagnosticMessage(child as { messageText: string; next?: readonly unknown[] })]
        : [],
    ) ?? []
  return [message.messageText, ...children].join('\n')
}

async function javascriptWorker(monaco: typeof Monaco) {
  let lastError: unknown
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await monaco.typescript.getJavaScriptWorker()
    } catch (error) {
      if (!String(error).includes('JavaScript not registered')) throw error
      lastError = error
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    }
  }
  throw lastError
}

async function compileWithMonaco(source: string, hash: string, ast: File): Promise<CompiledCalculationSource> {
  const monaco = await loadMonaco()
  const compilationId = crypto.randomUUID()
  const declaration = monaco.typescript.javascriptDefaults.addExtraLib(
    CALCULATION_MONACO_DECLARATION,
    `file:///caemble-calculation/${hash}/${compilationId}/calculation-env.d.ts`,
  )
  const model = monaco.editor.createModel(
    source,
    'javascript',
    monaco.Uri.parse(`file:///caemble-calculation/${hash}/${compilationId}/calculation.js`),
  )
  try {
    const workerFactory = await javascriptWorker(monaco)
    const worker = await workerFactory(model.uri)
    const [syntactic, semantic] = await Promise.all([
      worker.getSyntacticDiagnostics(model.uri.toString()),
      worker.getSemanticDiagnostics(model.uri.toString()),
    ])
    const errors = [...syntactic, ...semantic].filter((diagnostic) => diagnostic.category === 1)
    if (errors.length > 0) {
      throw new CalculationExecutionError(
        'compile',
        errors.map((diagnostic) => diagnosticMessage(diagnostic.messageText)).join('\n'),
      )
    }
    return transformCalculationSource(source, hash, ast)
  } finally {
    model.dispose()
    declaration.dispose()
  }
}

export async function compileCalculationSource(source: string): Promise<CompiledCalculationSource> {
  const ast = analyzeCalculationSource(source)
  const hash = await sourceHash(source)
  let compiled = compilationCache.get(hash)
  if (!compiled) {
    compiled = compileWithMonaco(source, hash, ast).catch((error) => {
      compilationCache.delete(hash)
      throw error
    })
    compilationCache.set(hash, compiled)
    if (compilationCache.size > 32) compilationCache.delete(compilationCache.keys().next().value!)
  }
  return compiled
}
