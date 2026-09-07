import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import type { AuthoringDiagnostic } from '../../authoring/diagnostics'
import type { CatalogRuntimeSlice } from '@/contracts/catalog'
import type { CompiledCadDocument } from '@/lib/cad/compiler/types'
import { catalogRuntimeTypes } from '@/lib/cad/compiler/catalogTypeEnvironment'
import { cadCompilerOptions } from '@/lib/cad/compiler/options'
import { experimentTypeScriptPaths } from '@/lib/cad/source/moduleResolution'
import { assertExperimentModuleGraph } from '@/lib/cad/source/sourceAnalysis'
import { assertCadSourcePolicy } from '@/lib/cad/source/sourcePolicy'

export function compileNodeCadDocument(
  files: Readonly<Record<string, string>>,
  sourceHash: string,
  catalog: CatalogRuntimeSlice,
  declarationsDirectory = path.dirname(ts.getDefaultLibFilePath({})),
): CompiledCadDocument {
  const sources = Object.fromEntries(experimentTypeScriptPaths(files).map((name) => [name, files[name]]))
  for (const [name, source] of Object.entries(sources)) {
    try {
      assertCadSourcePolicy(name, source)
    } catch (cause) {
      const problem = cause instanceof Error ? cause : new Error(String(cause))
      throw Object.assign(problem, {
        code: 'source-policy',
        stage: 'source-policy',
        language: 'typescript',
        sourceHash,
        referenceId: 'diagnostic.experiment',
        diagnostics: [
          {
            stage: 'source-policy',
            language: 'typescript',
            code: 'source-policy',
            message: problem.message,
            file: name,
            sourceHash,
            referenceId: 'experiment.modules',
            location: null,
          },
        ],
      })
    }
  }
  try {
    assertExperimentModuleGraph(sources)
  } catch (cause) {
    const problem = cause instanceof Error ? cause : new Error(String(cause))
    throw Object.assign(problem, {
      code: 'module-graph',
      stage: 'module-graph',
      language: 'typescript',
      sourceHash,
      referenceId: 'diagnostic.experiment',
      diagnostics: [
        {
          stage: 'module-graph',
          language: 'typescript',
          code: 'module-graph',
          message: problem.message,
          sourceHash,
          referenceId: 'experiment.modules',
          location: null,
        },
      ],
    })
  }

  const virtualRoot = '/caemble-source'
  const virtualFiles = new Map(Object.entries(sources).map(([name, source]) => [`${virtualRoot}/${name}`, source]))
  virtualFiles.set(
    `${virtualRoot}/core.d.ts`,
    readFileSync(path.join(declarationsDirectory, 'caemble-core.d.ts'), 'utf8'),
  )
  virtualFiles.set(`${virtualRoot}/jsx.d.ts`, readFileSync(path.join(declarationsDirectory, 'cad-jsx.d.ts'), 'utf8'))
  virtualFiles.set(`${virtualRoot}/catalog.d.ts`, catalogRuntimeTypes(catalog))
  // Monaco requests source diagnostics only. Ambient declarations are trusted and
  // the checking program does not emit; transpileModule below uses the shared emit options.
  const options: ts.CompilerOptions = {
    ...cadCompilerOptions(ts),
    noEmit: true,
    skipLibCheck: true,
    types: [],
    baseUrl: virtualRoot,
    paths: { '@caemble/core': ['./core.d.ts'] },
  }
  const host = ts.createCompilerHost(options)
  const readFile = host.readFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  const directoryExists = host.directoryExists?.bind(host)
  host.readFile = (name) => virtualFiles.get(name.replace(/\\/gu, '/')) ?? readFile(name)
  host.fileExists = (name) => virtualFiles.has(name.replace(/\\/gu, '/')) || fileExists(name)
  host.directoryExists = (name) => name.replace(/\\/gu, '/').startsWith(virtualRoot) || Boolean(directoryExists?.(name))
  host.getSourceFile = (name, languageVersion) => {
    const source = host.readFile(name)
    return source === undefined ? undefined : ts.createSourceFile(name, source, languageVersion)
  }
  const program = ts.createProgram([...virtualFiles.keys()], options, host)
  const errors = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  if (errors.length > 0) {
    const problem = new Error(
      ts.formatDiagnostics(errors, {
        getCurrentDirectory: () => virtualRoot,
        getCanonicalFileName: (name) => name,
        getNewLine: () => '\n',
      }),
    )
    const diagnostics: AuthoringDiagnostic[] = errors.map((diagnostic) => {
      const start =
        diagnostic.file && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
          : undefined
      const end =
        diagnostic.file && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start + (diagnostic.length ?? 0))
          : undefined
      return {
        stage: 'compile',
        language: 'typescript',
        code: `TS${diagnostic.code}`,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        sourceHash,
        referenceId: 'experiment.contract',
        location: start
          ? {
              file: diagnostic.file!.fileName.startsWith(`${virtualRoot}/`)
                ? diagnostic.file!.fileName.slice(virtualRoot.length + 1)
                : diagnostic.file!.fileName,
              line: start.line + 1,
              column: start.character + 1,
            }
          : null,
        ...(diagnostic.file
          ? {
              file: diagnostic.file.fileName.startsWith(`${virtualRoot}/`)
                ? diagnostic.file.fileName.slice(virtualRoot.length + 1)
                : diagnostic.file.fileName,
            }
          : {}),
        ...(start && end
          ? {
              range: {
                startLineNumber: start.line + 1,
                startColumn: start.character + 1,
                endLineNumber: end.line + 1,
                endColumn: end.character + 1,
              },
              sourceLine: diagnostic.file!.text.split(/\r?\n/)[start.line] ?? '',
            }
          : {}),
      }
    })
    throw Object.assign(problem, {
      code: 'compile',
      stage: 'compile',
      language: 'typescript',
      sourceHash,
      referenceId: 'diagnostic.experiment',
      diagnostics,
    })
  }
  return Object.freeze({
    sourceHash,
    sources: Object.freeze(
      Object.fromEntries(
        Object.entries(sources).map(([name, source]) => [
          name,
          {
            entryFile: name,
            sourceHash,
            code: ts.transpileModule(source, { compilerOptions: cadCompilerOptions(ts), fileName: name }).outputText,
          },
        ]),
      ),
    ),
  })
}
