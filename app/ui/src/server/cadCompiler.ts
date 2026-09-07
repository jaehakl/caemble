import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import type { CatalogRuntimeSlice } from '../contracts/catalog'
import type { CompiledCadDocument } from '../lib/cad/compiler/types'
import { catalogRuntimeTypes } from '../lib/cad/compiler/catalogTypeEnvironment'
import { cadCompilerOptions } from '../lib/cad/compiler/options'
import { experimentTypeScriptPaths } from '../lib/cad/source/moduleResolution'
import { assertExperimentModuleGraph } from '../lib/cad/source/sourceAnalysis'
import { assertCadSourcePolicy } from '../lib/cad/source/sourcePolicy'

export function compileServerCadDocument(
  files: Readonly<Record<string, string>>,
  sourceHash: string,
  catalog: CatalogRuntimeSlice,
  declarationsDirectory = path.dirname(ts.getDefaultLibFilePath({})),
): CompiledCadDocument {
  const sources = Object.fromEntries(experimentTypeScriptPaths(files).map((name) => [name, files[name]]))
  for (const [name, source] of Object.entries(sources)) assertCadSourcePolicy(name, source)
  assertExperimentModuleGraph(sources)

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
    throw new Error(
      ts.formatDiagnostics(errors, {
        getCurrentDirectory: () => virtualRoot,
        getCanonicalFileName: (name) => name,
        getNewLine: () => '\n',
      }),
    )
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
