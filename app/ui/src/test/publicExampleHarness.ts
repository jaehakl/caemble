import { geometries, measurements } from '@jscad/modeling'
import ts from 'typescript'
import { expect } from 'vitest'
import { CAD_COMPILER_VERSION, type CompiledCadDocument, type CompiledCadSource } from '@/lib/cad/compiler/types'
import type { CadScene } from '@/lib/cad/evaluation/types'
import { executeCompiledDocument, inspectCompiledDocument } from '@/lib/cad/execution/userModule'
import { generateRandomVars } from '@/lib/cad/model/vars'
import {
  analyzeBundleModuleSource,
  analyzeCadSource,
  analyzeGeometrySource,
  analyzeMaterialSource,
  analyzeTaskSource,
  assertExperimentModuleGraph,
} from '@/lib/cad/source/sourceAnalysis'
import {
  assertExperimentSourceBundle,
  CAD_SOURCE_API_VERSION,
  createExperimentSourceBundle,
  experimentTaskName,
  type ExperimentSourceBundle,
} from '@/lib/cad/source/document'
import { experimentTypeScriptPaths } from '@/lib/cad/source/moduleResolution'
import type { Vars } from '@/lib/cad/model/types'

const previewPythonSource = 'async def simulate(*, sim, tasks, vars):\n    return None\n'
const previewTaskSource = `import { defineTask } from '@caemble/core'
export default defineTask({ kernel: { name: 'public-example-preview', version: '1.0.0' }, config: () => ({}) })
`

function compileSource(source: string, entryFile: string) {
  // cad-api.test.ts owns semantic declaration checking; this stage mirrors the production Monaco emit settings
  // before passing the result through the real document inspector and evaluator.
  const result = ts.transpileModule(source, {
    compilerOptions: {
      allowNonTsExtensions: true,
      inlineSources: true,
      jsx: ts.JsxEmit.React,
      jsxFactory: 'h',
      jsxFragmentFactory: 'Fragment',
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      noEmit: false,
      noEmitOnError: true,
      sourceMap: true,
      strict: true,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: entryFile,
    reportDiagnostics: true,
  })
  const errors = (result.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  if (errors.length > 0) {
    throw new Error(
      errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'),
    )
  }
  return result.outputText.replace(/\r?\n\/\/# sourceMappingURL=.*?(?:\r?\n)?$/u, '')
}

export function standalonePublicExampleBundle(experimentSource: string) {
  return createExperimentSourceBundle({
    'experiment.tsx': experimentSource,
    'geometry.tsx': 'export {}\n',
    'material.tsx': 'export {}\n',
    'simulate.py': previewPythonSource,
    'tasks/preview.tsx': previewTaskSource,
  })
}

export function inspectPublicExampleBundle(bundle: ExperimentSourceBundle) {
  assertExperimentSourceBundle(bundle)
  assertExperimentModuleGraph(bundle.files)
  const sourceHash = 'e'.repeat(64)
  const entries = experimentTypeScriptPaths(bundle.files).map((path) => [path, bundle.files[path]] as const)
  const sources = Object.fromEntries(
    entries.map(([entryFile, source]) => {
      if (entryFile === 'experiment.tsx') analyzeCadSource(source)
      else if (entryFile === 'geometry.tsx') analyzeGeometrySource(source, { allowEmpty: true })
      else if (entryFile === 'material.tsx') analyzeMaterialSource(source)
      else if (experimentTaskName(entryFile) !== null) analyzeTaskSource(source)
      else analyzeBundleModuleSource(source, entryFile)
      const compiled: CompiledCadSource = {
        apiVersion: CAD_SOURCE_API_VERSION,
        compilerVersion: CAD_COMPILER_VERSION,
        entryFile,
        code: compileSource(source, entryFile),
        sourceHash,
      }
      return [entryFile, compiled]
    }),
  )
  const document: CompiledCadDocument = {
    apiVersion: CAD_SOURCE_API_VERSION,
    compilerVersion: CAD_COMPILER_VERSION,
    sourceHash,
    sources,
  }
  return { document, inspection: inspectCompiledDocument(document) }
}

export async function evaluatePublicExampleBundle(bundle: ExperimentSourceBundle, variables?: Readonly<Vars>) {
  const { document, inspection } = inspectPublicExampleBundle(bundle)
  return executeCompiledDocument(
    document,
    variables ?? generateRandomVars(inspection.varsSchema),
    bundle.files['simulate.py'],
  )
}

export function expectReliablePublicScene(scene: CadScene, options: { allowEmpty?: boolean } = {}) {
  if (!options.allowEmpty) expect(scene.parts.length).toBeGreaterThan(0)

  const partIds = scene.parts.map(({ id }) => id)
  const surfaceIds = scene.parts.flatMap(({ surfaces }) => surfaces.map(({ id }) => id))
  expect(new Set(partIds).size).toBe(partIds.length)
  expect(new Set(surfaceIds).size).toBe(surfaceIds.length)
  expect(scene.geometryGroups.flatMap(({ missingMemberIds }) => missingMemberIds)).toEqual([])
  expect(scene.surfaceGroups.flatMap(({ missingMemberIds }) => missingMemberIds)).toEqual([])

  scene.parts.forEach((part) => {
    expect(geometries.geom3.isA(part.geometry)).toBe(true)
    expect(measurements.measureVolume(part.geometry), part.id).toBeGreaterThan(0)
    expect(part.surfaces.length).toBeGreaterThan(0)
  })
}
