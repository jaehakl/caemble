import type { typescript as MonacoTypeScript } from 'monaco-editor'
import type { SourceFile } from 'typescript'
import { TypeScriptWorker } from 'monaco-editor/languages/features/typescript/tsWorker.js'
import { typescript } from 'monaco-editor/languages/features/typescript/lib/typescriptServices.js'
import { EXPERIMENT_ENTRY_PATH } from '../source/document'
import { assertExperimentModuleGraph } from '../source/sourceAnalysis'
import { assertCadSourcePolicy } from '../source/sourcePolicy'
import { CadCompilationError } from './compilationError'
import { cadCompilerDeclarations } from './compilerDeclarations'
import type { CadCompilationInput } from './compilerProtocol'
import { cadCompilerOptions } from './options'
import type { CadDiagnostic, CompiledCadDocument, CompiledCadSource } from './types'

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

function convertDiagnostic(
  diagnostic: MonacoTypeScript.Diagnostic,
  source: SourceFile,
  file: string,
  phase: 'semantic' | 'syntax',
): CadDiagnostic {
  const start = Math.min(source.text.length, Math.max(0, diagnostic.start ?? 0))
  const end = Math.min(source.text.length, start + Math.max(0, diagnostic.length ?? 0))
  const startPosition = source.getLineAndCharacterOfPosition(start)
  const endPosition = source.getLineAndCharacterOfPosition(end)
  return {
    code: diagnostic.code,
    file,
    message: diagnosticMessage(diagnostic.messageText),
    phase,
    range: {
      startLineNumber: startPosition.line + 1,
      startColumn: startPosition.character + 1,
      endLineNumber: endPosition.line + 1,
      endColumn: endPosition.character + 1,
    },
    severity: diagnostic.category === 1 ? 'error' : diagnostic.category === 0 ? 'warning' : 'info',
  }
}

export async function compileVirtualCadDocument(input: CadCompilationInput): Promise<CompiledCadDocument> {
  const { sources, sourceHash } = input
  for (const [path, source] of Object.entries(sources)) {
    try {
      assertCadSourcePolicy(path, source)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      throw new CadCompilationError('policy', message, [
        {
          code: 'CAD_POLICY',
          file: path,
          message,
          phase: 'policy',
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
          severity: 'error',
        },
      ])
    }
  }
  try {
    assertExperimentModuleGraph(sources)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new CadCompilationError('policy', message, [
      {
        code: 'CAD_MODULE_GRAPH',
        file: EXPERIMENT_ENTRY_PATH,
        message,
        phase: 'policy',
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
        severity: 'error',
      },
    ])
  }
  const root = `file:///caemble-source/${sourceHash}/`
  // A fresh language service owns exactly one immutable document and its catalog.
  // No editor models, global extra libraries, or asynchronous model synchronization.
  const checker = new TypeScriptWorker(
    { getMirrorModels: () => [] },
    {
      compilerOptions: cadCompilerOptions(typescript),
      extraLibs: {
        ...cadCompilerDeclarations,
        'file:///node_modules/@caemble/core/catalog-runtime.d.ts': { content: input.catalogTypes, version: 1 },
        ...Object.fromEntries(Object.entries(sources).map(([path, content]) => [root + path, { content, version: 1 }])),
      },
    },
  )
  try {
    const diagnostics: CadDiagnostic[] = []
    for (const path of Object.keys(sources)) {
      const uri = root + path
      const syntactic = await checker.getSyntacticDiagnostics(uri)
      const semantic = await checker.getSemanticDiagnostics(uri)
      const source = checker.getLanguageService().getProgram()?.getSourceFile(uri)
      if (!source) throw new CadCompilationError('compile', `TypeScript did not load ${path}.`)
      diagnostics.push(
        ...syntactic.map((entry) => convertDiagnostic(entry, source, path, 'syntax')),
        ...semantic.map((entry) => convertDiagnostic(entry, source, path, 'semantic')),
      )
    }
    const errors = diagnostics.filter((entry) => entry.severity === 'error')
    if (errors.length) {
      throw new CadCompilationError(
        'type',
        errors
          .map((entry) => `${entry.file}:${entry.range.startLineNumber}:${entry.range.startColumn} ${entry.message}`)
          .join('\n'),
        diagnostics,
      )
    }
    const compiled: Record<string, CompiledCadSource> = {}
    for (const path of Object.keys(sources)) {
      const output = await checker.getEmitOutput(root + path)
      const code = output.outputFiles.find((entry) => entry.name.endsWith('.js'))?.text
      const sourceMap = output.outputFiles.find((entry) => entry.name.endsWith('.js.map'))?.text
      if (output.emitSkipped || code === undefined) {
        throw new CadCompilationError('compile', `TypeScript did not emit JavaScript for ${path}.`, diagnostics)
      }
      compiled[path] = {
        entryFile: path,
        code: `${code.replace(/\r?\n\/\/# sourceMappingURL=.*?(?:\r?\n)?$/u, '')}\n//# sourceURL=caemble://${sourceHash}/${path}`,
        ...(sourceMap === undefined ? {} : { sourceMap }),
        sourceHash,
      }
    }
    return { sourceHash, sources: compiled }
  } finally {
    checker.getLanguageService().dispose()
  }
}
