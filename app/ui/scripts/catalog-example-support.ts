import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import type { CatalogExperimentDetail, CatalogRuntimeSlice } from '../src/contracts/catalog'
import type { CompiledCadDocument } from '../src/lib/cad/compiler/types'
import { catalogRuntimeTypes } from '../src/lib/cad/compiler/catalogTypeEnvironment'
import {
  analyzeBundleModuleSource,
  analyzeCadSource,
  analyzeGeometrySource,
  analyzeMaterialSource,
  analyzeTaskSource,
  assertExperimentModuleGraph,
} from '../src/lib/cad/source/sourceAnalysis'

export function readCatalogExamples(database: string) {
  return JSON.parse(
    execFileSync(
      'python',
      [
        '-X',
        'utf8',
        '-c',
        `
import sys,json
sys.path.insert(0,sys.argv[2])
from caemble_catalog import open_catalog
with open_catalog(sys.argv[1]) as c:
 solvers=c.list_solvers()
 runtime=c.runtime_slice(
  solvers=[(s['name'],s['version']) for s in solvers],
  quantity_kinds=[q['name'] for q in c.list_quantity_kinds(limit=10000)[0]],
  material_parameters=[m['key'] for m in c.list_material_parameters(limit=10000)[0]],
  material_models=[m['key'] for m in c.list_material_models(limit=10000)[0]])
 examples=[c.experiment(e['coordinate']) for e in c.list_experiments(limit=10000)[0]]
 print(json.dumps(dict(examples=examples,catalog=runtime)))
`,
        database,
        path.resolve('../catalog'),
      ],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    ),
  ) as { examples: CatalogExperimentDetail[]; catalog: CatalogRuntimeSlice }
}

export function compileCatalogExample(
  example: CatalogExperimentDetail,
  catalog: CatalogRuntimeSlice,
): CompiledCadDocument {
  const files = example.sourceBundle.files
  for (const [name, source] of Object.entries(files)) {
    if (name === 'experiment.tsx') analyzeCadSource(source)
    else if (name === 'geometry.tsx') analyzeGeometrySource(source)
    else if (name === 'material.tsx') analyzeMaterialSource(source)
    else if (name.startsWith('tasks/')) analyzeTaskSource(source)
    else if (/\.tsx?$/u.test(name)) analyzeBundleModuleSource(source, name)
  }
  assertExperimentModuleGraph(files)
  const virtualRoot = path.resolve('node_modules/.tmp/catalog-source', example.key).replaceAll('\\', '/')
  const virtualFiles = new Map(
    Object.entries(files)
      .filter(([name]) => /\.tsx?$/u.test(name))
      .map(([name, source]) => [`${virtualRoot}/${name}`, source]),
  )
  virtualFiles.set(`${virtualRoot}/core.d.ts`, readFileSync('src/lib/cad/api/caemble-core.d.ts', 'utf8'))
  virtualFiles.set(`${virtualRoot}/jsx.d.ts`, readFileSync('src/lib/cad/api/cad-jsx.d.ts', 'utf8'))
  virtualFiles.set(`${virtualRoot}/catalog.d.ts`, catalogRuntimeTypes(catalog))
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    baseUrl: virtualRoot,
    paths: { '@caemble/core': ['./core.d.ts'] },
    jsx: ts.JsxEmit.React,
    jsxFactory: 'h',
    jsxFragmentFactory: 'Fragment',
  }
  const host = ts.createCompilerHost(options)
  const readFile = host.readFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  const directoryExists = host.directoryExists?.bind(host)
  host.readFile = (name) => virtualFiles.get(name.replaceAll('\\', '/')) ?? readFile(name)
  host.fileExists = (name) => virtualFiles.has(name.replaceAll('\\', '/')) || fileExists(name)
  host.directoryExists = (name) =>
    name.replaceAll('\\', '/').startsWith(virtualRoot) || Boolean(directoryExists?.(name))
  host.getSourceFile = (name, languageVersion) => {
    const source = host.readFile(name)
    return source === undefined ? undefined : ts.createSourceFile(name, source, languageVersion)
  }
  const program = ts.createProgram([...virtualFiles.keys()], options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  assert.equal(
    diagnostics.length,
    0,
    `${example.coordinate}\n${ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => process.cwd(),
      getCanonicalFileName: (name) => name,
      getNewLine: () => '\n',
    })}`,
  )
  return {
    sourceHash: example.bundleHash,
    sources: Object.fromEntries(
      Object.entries(files)
        .filter(([name]) => /\.tsx?$/u.test(name))
        .map(([name, source]) => [
          name,
          {
            entryFile: name,
            sourceHash: example.bundleHash,
            code: ts.transpileModule(source, { compilerOptions: { ...options, noEmit: false }, fileName: name })
              .outputText,
          },
        ]),
    ),
  }
}
