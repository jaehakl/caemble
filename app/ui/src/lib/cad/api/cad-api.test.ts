import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { defaultCode } from '../../defaultCode'
import { defaultExperimentCode } from '../../defaultExperimentCode'
import {
  defaultExperimentGeometryCode,
  defaultExperimentMaterialCode,
  defaultExperimentProgramCode,
  defaultExperimentTaskCode,
} from '../../defaultExperimentProgramCode'
import { caembleExamples, caembleProgramExamples, wheelAssemblyExample } from '../../examples'
import { blankExperimentSourceBundle, starterExperimentSourceBundle } from '../../localExperimentCode'
import { geometryCoordinateTypes } from '../compiler/geometryTypes'
import type { EffectiveGeometryGraph } from '../source/effectiveGeometryGraph'
import type { GeometryCoordinate } from '../source/geometrySnapshot'
import coreTypes from './caemble-core.d.ts?raw'
import jsxTypes from './cad-jsx.d.ts?raw'

const experimentProgramDoc = readFileSync(
  new URL('../../../../../../docs/experiment-program.md', import.meta.url),
  'utf8',
)

const defaultGeometryFiles = {
  'C:/caemble-source/hash/geometry.tsx': defaultExperimentGeometryCode,
  'C:/caemble-source/hash/material.tsx': defaultExperimentMaterialCode,
}

function diagnosticsFor(
  source: string,
  additionalFiles: Readonly<Record<string, string>> = defaultGeometryFiles,
  sourcePath = 'C:/caemble-source/hash/experiment.tsx',
) {
  const virtualFiles = new Map<string, string>([
    ...Object.entries(additionalFiles),
    [sourcePath, source],
    ['C:/node_modules/@caemble/core/index.d.ts', coreTypes],
    ['C:/node_modules/@caemble/core/cad-jsx.d.ts', jsxTypes],
  ])
  const options: ts.CompilerOptions = {
    allowNonTsExtensions: true,
    baseUrl: 'C:/',
    jsx: ts.JsxEmit.React,
    jsxFactory: 'h',
    jsxFragmentFactory: 'Fragment',
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    noEmit: true,
    skipLibCheck: false,
    strict: true,
    target: ts.ScriptTarget.ES2020,
    types: [],
    paths: {
      '@caemble/core': ['node_modules/@caemble/core/index.d.ts'],
    },
  }
  const host = ts.createCompilerHost(options)
  const defaultFileExists = host.fileExists.bind(host)
  const defaultReadFile = host.readFile.bind(host)
  const defaultDirectoryExists = host.directoryExists?.bind(host)
  host.fileExists = (path) => virtualFiles.has(path.replace(/\\/g, '/')) || defaultFileExists(path)
  host.readFile = (path) => virtualFiles.get(path.replace(/\\/g, '/')) ?? defaultReadFile(path)
  host.directoryExists = (path) => {
    const normalized = path.replace(/\\/g, '/')
    return (
      [...virtualFiles.keys()].some((filename) => filename.startsWith(`${normalized}/`)) ||
      defaultDirectoryExists?.(path) ||
      false
    )
  }
  host.getSourceFile = (path, languageVersion) => {
    const text = host.readFile(path)
    return text === undefined ? undefined : ts.createSourceFile(path, text, languageVersion, true)
  }
  const program = ts.createProgram({
    rootNames: [sourcePath, 'C:/node_modules/@caemble/core/cad-jsx.d.ts', ...Object.keys(additionalFiles)],
    options,
    host,
  })
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
}

describe('unversioned CAD authoring declarations', () => {
  it('uses the TypeScript version embedded in Monaco and a callable JSX fragment factory', () => {
    expect(ts.version).toBe('5.9.3')
    expect(jsxTypes).toContain('function Fragment(')
    expect(jsxTypes).not.toContain('const Fragment: unknown')
  })

  it('type-checks the v6 Experiment and Task defaults', () => {
    expect(defaultExperimentCode).toBe(defaultExperimentProgramCode)
    expect(diagnosticsFor(defaultCode)).toEqual([])
    expect(
      diagnosticsFor(defaultExperimentTaskCode, defaultGeometryFiles, 'C:/caemble-source/hash/tasks/electric.tsx'),
    ).toEqual([])
  })

  it('requires the common Experiment geometry contract', () => {
    expect(
      diagnosticsFor(`import { experiment } from '@caemble/core'
      export default experiment({ varsSchema: {}, recordedData: {} })`),
    ).toContainEqual(expect.stringContaining('geometry, lengthUnit'))
  })

  it('makes destructuring defaults optional while preserving id and props without defaults', () => {
    const coordinate = 'caemble:geometry/jlee/common/notched@1.0.0' as GeometryCoordinate
    const graph = {
      graphHash: 'a'.repeat(64),
      entryImports: [{ exportName: 'Notched', alias: 'Notched', coordinate, moduleHash: 'b'.repeat(64) }],
      modules: [
        {
          coordinate,
          sourceHash: 'c'.repeat(64),
          moduleHash: 'b'.repeat(64),
          exports: ['Notched'],
          imports: [],
          source: `import { type Geometry, type Vec3 } from '@caemble/core'
export const Notched: Geometry<{ size: Vec3; thickness: number }> = ({ size = [1, 2, 3], thickness }) => <box size={size} scale={[thickness, 1, 1]} />`,
        },
      ],
    } satisfies EffectiveGeometryGraph
    const prefix = 'C:/caemble-source/hash'
    const files = {
      [`${prefix}/geometry-coordinates.d.ts`]: geometryCoordinateTypes(graph),
      [`${prefix}/geometries/${encodeURIComponent(coordinate)}.tsx`]: graph.modules[0].source,
      [`${prefix}/geometry.tsx`]: `import { Notched } from "${coordinate}"\nexport { Notched }`,
    }
    const valid = 'import { Notched } from "./geometry"\nexport default <Notched id="root" thickness={2} />'

    expect(diagnosticsFor(valid, files)).toEqual([])
    expect(diagnosticsFor(valid.replace('thickness={2}', ''), files).join('\n')).toContain(
      "Property 'thickness' is missing",
    )
    expect(diagnosticsFor(valid.replace('id="root" ', ''), files).join('\n')).toContain("Property 'id' is missing")
    expect(diagnosticsFor(valid.replace('thickness={2}', 'size="large" thickness={2}'), files).join('\n')).toContain(
      "Type 'string' is not assignable",
    )
  })

  it.each(caembleExamples)('type-checks the $title example', ({ code }) => {
    expect(diagnosticsFor(code)).toEqual([])
  })

  it.each([...caembleProgramExamples, wheelAssemblyExample])('type-checks the $title Experiment bundle', (example) => {
    const prefix = 'C:/caemble-source/hash'
    const files = Object.fromEntries(
      Object.entries(example.experimentSourceBundle.files)
        .filter(([path]) => path.endsWith('.tsx'))
        .map(([path, source]) => [`${prefix}/${path}`, source]),
    )
    Object.entries(example.experimentSourceBundle.files)
      .filter(([path]) => path.endsWith('.tsx'))
      .forEach(([path, source]) => expect(diagnosticsFor(source, files, `${prefix}/${path}`)).toEqual([]))
  })

  it('type-checks the local Starter and Blank Experiment bundles', () => {
    for (const bundle of [starterExperimentSourceBundle, blankExperimentSourceBundle]) {
      const prefix = 'C:/caemble-source/hash'
      const files = Object.fromEntries(
        Object.entries(bundle.files)
          .filter(([path]) => path.endsWith('.tsx'))
          .map(([path, source]) => [`${prefix}/${path}`, source]),
      )
      Object.entries(bundle.files)
        .filter(([path]) => path.endsWith('.tsx'))
        .forEach(([path, source]) => expect(diagnosticsFor(source, files, `${prefix}/${path}`)).toEqual([]))
    }
  })

  it('type-checks the complete Experiment sources in the standalone guide', () => {
    const sources = [...experimentProgramDoc.matchAll(/```tsx\r?\n([\s\S]*?)```/g)].map((match) => match[1])
    expect(sources).toHaveLength(4)
    const prefix = 'C:/caemble-source/hash'
    const paths = ['geometry.tsx', 'experiment.tsx', 'material.tsx', 'tasks/electric.tsx']
    const files = Object.fromEntries(paths.map((path, index) => [`${prefix}/${path}`, sources[index]]))
    sources.forEach((source, index) => expect(diagnosticsFor(source, files, `${prefix}/${paths[index]}`)).toEqual([]))
  })

  it('rejects unknown vars and tuple shapes', () => {
    const unknownVar = defaultCode.replace('size={vars.conductorSize}', 'size={vars.unknownSize}')
    const wrongTuple = defaultCode.replace('size={vars.conductorSize}', 'size={[1, 2]}')

    expect(diagnosticsFor(unknownVar).join('\n')).toContain("Property 'unknownSize' does not exist")
    expect(diagnosticsFor(wrongTuple).join('\n')).toContain('Source has 2 element(s) but target requires 3')
  })

  it('keeps solver config generic so CAE performs contract validation', () => {
    const wrongMethod = defaultExperimentProgramCode.replace("methodId: 'dc.voxel-grid'", "methodId: 'dc.unknown'")
    const wrongParameter = defaultExperimentProgramCode.replace('gridShape: {', 'unknownGridShape: {')

    expect(diagnosticsFor(wrongMethod)).toEqual([])
    expect(diagnosticsFor(wrongParameter)).toEqual([])
  })

  it('keeps browser-side simulate orchestration out of new Experiment source', () => {
    expect(defaultExperimentProgramCode).not.toContain('simulate:')
    expect(defaultExperimentProgramCode).not.toContain('sim.run(')
  })

  it('keeps canonical Material property and model authoring types strict', () => {
    expect(coreTypes).toContain("'model.sorption.isotherm': Readonly<{")
    expect(coreTypes).toContain('{ color?: string; errorRate?: number }')
    expect(coreTypes).toContain('readonly errorRate: number')

    const localKey = defaultExperimentMaterialCode.replace(
      "'electrical.conductivity': {",
      'electricalConductivity: {',
    )
    const arbitraryKey = defaultExperimentMaterialCode.replace(
      "'electrical.conductivity': {",
      "'custom.conductivity': {",
    )
    const manualQuantityKind = defaultExperimentMaterialCode.replace(
      "unit: 'S.m-1',",
      "unit: 'S.m-1',\n      quantityKind: 'electromagnetism.ElectricConductivity',",
    )
    const materialPath = 'C:/caemble-source/hash/material.tsx'
    expect(diagnosticsFor(localKey, defaultGeometryFiles, materialPath).join('\n')).toContain('electricalConductivity')
    expect(diagnosticsFor(arbitraryKey, defaultGeometryFiles, materialPath).join('\n')).toContain('custom.conductivity')
    expect(diagnosticsFor(manualQuantityKind, defaultGeometryFiles, materialPath).join('\n')).toContain(
      "Type 'string' is not assignable to type 'undefined'",
    )

    const modelRelation = `
      import { Material } from '@caemble/core'
      new Material('Sorbent', {
        'model.sorption.isotherm': {
          kind: 'sampled_relation',
          input: { unit: '%', values: [0, 100] },
          output: { unit: '{fraction}', values: [0, 0.2] },
        },
      })
    `
    expect(diagnosticsFor(modelRelation)).toEqual([])
    expect(
      diagnosticsFor(modelRelation.replace('model.sorption.isotherm', 'model.sorption.local_isotherm')).join('\n'),
    ).toContain('model.sorption.local_isotherm')
  })
})
