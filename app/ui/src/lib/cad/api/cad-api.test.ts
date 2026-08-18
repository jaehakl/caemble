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
import { buildSyntheticCatalog } from '../../../test/syntheticCatalog'
import { catalogRuntimeTypes } from '../compiler/catalogTypeEnvironment'
import { cadElementCatalog } from '../catalog'
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
  catalogTypes?: string,
) {
  const virtualFiles = new Map<string, string>([
    ...Object.entries(additionalFiles),
    [sourcePath, source],
    ['C:/node_modules/@caemble/core/index.d.ts', coreTypes],
    ['C:/node_modules/@caemble/core/cad-jsx.d.ts', jsxTypes],
    ...(catalogTypes === undefined
      ? []
      : ([['C:/node_modules/@caemble/core/catalog-runtime.d.ts', catalogTypes]] as const)),
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
    rootNames: [
      sourcePath,
      'C:/node_modules/@caemble/core/cad-jsx.d.ts',
      ...Object.keys(additionalFiles),
      ...(catalogTypes === undefined ? [] : ['C:/node_modules/@caemble/core/catalog-runtime.d.ts']),
    ],
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

  it('type-checks the v7 Experiment and Task defaults', () => {
    expect(defaultExperimentCode).toBe(defaultExperimentProgramCode)
    expect(diagnosticsFor(defaultCode)).toEqual([])
    expect(
      diagnosticsFor(defaultExperimentTaskCode, defaultGeometryFiles, 'C:/caemble-source/hash/tasks/electric.tsx'),
    ).toEqual([])
  })

  it('accepts canonical transforms and legacy compatibility while rejecting mixed or invented transform props', () => {
    const prefix = `import { type Geometry } from '@caemble/core'\n`
    const sourcePath = 'C:/caemble-source/hash/geometry.tsx'

    expect(
      diagnosticsFor(
        `${prefix}export const Canonical: Geometry = () => <box id="body" size={[1, 2, 3]} position={[4, 5, 6]} rotation={[0.1, 0.2, 0.3]} scale={[2, 2, 2]} />`,
        {},
        sourcePath,
      ),
    ).toEqual([])
    expect(
      diagnosticsFor(
        `${prefix}export const Legacy: Geometry = () => <box size={[1, 2, 3]} pos={[4, 5, 6]} rotate={{ axis: [0, 0, 1], angle: 1 }} />`,
        {},
        sourcePath,
      ),
    ).toEqual([])
    expect(
      diagnosticsFor(
        `${prefix}export const Mixed: Geometry = () => <box size={[1, 2, 3]} position={[0, 0, 0]} pos={[0, 0, 0]} />`,
        {},
        sourcePath,
      ).join('\n'),
    ).toContain('not assignable')
    expect(
      diagnosticsFor(
        `${prefix}export const Invented: Geometry = () => <box size={[1, 2, 3]} translation={[0, 0, 0]} />`,
        {},
        sourcePath,
      ).join('\n'),
    ).toContain("Property 'translation' does not exist")
    expect(
      diagnosticsFor(
        `${prefix}export const InvalidFragment: Geometry = () => <Fragment id="group"><box size={[1, 1, 1]} /></Fragment>`,
        {},
        sourcePath,
      ).join('\n'),
    ).toContain("Property 'id' does not exist")
  })

  it.each(cadElementCatalog)('type-checks the $tag canonical manifest example', (manifest) => {
    expect(
      diagnosticsFor(
        `import { type Geometry } from '@caemble/core'\nexport const Example: Geometry = () => (${manifest.example})`,
        {},
        'C:/caemble-source/hash/geometry.tsx',
      ),
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

  it('keeps catalog literals runtime-scoped while preserving strict Material authoring types', () => {
    const runtimeTypes = catalogRuntimeTypes(
      buildSyntheticCatalog({
        quantityKinds: [
          { name: 'synthetic.Scalar', tensorOrder: 0, applicableUnits: ['{synthetic-scalar}'] },
          { name: 'synthetic.Vector', tensorOrder: 1, applicableUnits: ['{synthetic-vector}'] },
        ],
        materialParameters: [{ key: 'synthetic.vector-property', quantityKind: 'synthetic.Vector' }],
        materialModels: [
          {
            key: 'model.synthetic.relation',
            labelKo: 'Synthetic relation',
            kind: 'sampled_relation',
            input: { name: 'input', quantityKind: 'synthetic.Scalar' },
            output: { name: 'output', quantityKind: 'synthetic.Vector' },
            minimumSamples: 2,
            sharedBasis: false,
          },
        ],
      }),
    )

    expect(coreTypes).toContain('export interface CatalogQuantityKindMap {}')
    expect(coreTypes).toContain('export interface MaterialPropertyQuantityKindMap {}')
    expect(coreTypes).toContain('export interface MaterialModelDefinitionMap {}')
    expect(coreTypes).not.toContain('synthetic.Scalar')
    expect(coreTypes).not.toContain('synthetic.vector-property')
    expect(coreTypes).not.toContain('model.synthetic.relation')
    expect(runtimeTypes).toContain('"synthetic.Scalar"')
    expect(runtimeTypes).toContain('"synthetic.Vector"')
    expect(runtimeTypes).toContain('"synthetic.vector-property"')
    expect(runtimeTypes).toContain('"model.synthetic.relation"')
    expect(runtimeTypes).not.toContain('synthetic.Omitted')
    expect(coreTypes).toContain('{ color?: string; errorRate?: number }')
    expect(coreTypes).toContain('readonly errorRate: number')

    const materialSource = `
      import { Material } from '@caemble/core'
      new Material('Synthetic', {
        'synthetic.vector-property': {
          dtype: 'float64',
          value: [1, 2, 3],
          unit: '{synthetic-vector}',
          basis: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        },
      })
    `
    const materialPath = 'C:/caemble-source/hash/material.tsx'
    expect(diagnosticsFor(materialSource, defaultGeometryFiles, materialPath, runtimeTypes)).toEqual([])
    expect(
      diagnosticsFor(
        materialSource.replace('synthetic.vector-property', 'synthetic.unknown-property'),
        defaultGeometryFiles,
        materialPath,
        runtimeTypes,
      ).join('\n'),
    ).toContain('synthetic.unknown-property')
    expect(
      diagnosticsFor(
        materialSource.replace(
          "unit: '{synthetic-vector}',",
          "unit: '{synthetic-vector}',\n          quantityKind: 'synthetic.Vector',",
        ),
        defaultGeometryFiles,
        materialPath,
        runtimeTypes,
      ).join('\n'),
    ).toContain("Type 'string' is not assignable to type 'undefined'")

    const modelRelation = `
      import { Material } from '@caemble/core'
      new Material('Synthetic', {
        'model.synthetic.relation': {
          kind: 'sampled_relation',
          input: { unit: '{synthetic-scalar}', values: [0, 1] },
          output: { unit: '{synthetic-vector}', values: [[0, 0, 0], [1, 1, 1]] },
        },
      })
    `
    expect(diagnosticsFor(modelRelation, defaultGeometryFiles, materialPath, runtimeTypes)).toEqual([])
    expect(
      diagnosticsFor(
        modelRelation.replace('model.synthetic.relation', 'model.synthetic.omitted'),
        defaultGeometryFiles,
        materialPath,
        runtimeTypes,
      ).join('\n'),
    ).toContain('model.synthetic.omitted')
  })
})
