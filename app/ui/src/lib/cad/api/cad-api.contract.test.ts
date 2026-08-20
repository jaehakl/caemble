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
import {
  caembleExamples,
  caembleProgramExamples,
  geometryAuthoringSkeletonSourceBundle,
  wheelAssemblyExample,
} from '../../examples'
import { blankExperimentSourceBundle, starterExperimentSourceBundle } from '../../localExperimentCode'
import { buildSyntheticCatalog } from '../../../test/syntheticCatalog'
import { catalogRuntimeTypes } from '../compiler/catalogTypeEnvironment'
import { cadElementCatalog } from '../catalog'
import { geometryCoordinateTypes } from '../compiler/geometryTypes'
import type { EffectiveGeometryGraph } from '../source/effectiveGeometryGraph'
import type { GeometryCoordinate } from '../source/geometrySnapshot'
import coreTypes from './caemble-core.d.ts?raw'
import jsxTypes from './cad-jsx.d.ts?raw'

const defaultGeometryFiles = {
  'C:/caemble-source/hash/geometry.tsx': defaultExperimentGeometryCode,
  'C:/caemble-source/hash/material.tsx': defaultExperimentMaterialCode,
}

function diagnosticsForFiles(sourceFiles: Readonly<Record<string, string>>, catalogTypes?: string) {
  const virtualFiles = new Map<string, string>([
    ...Object.entries(sourceFiles),
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
      ...Object.keys(sourceFiles),
      'C:/node_modules/@caemble/core/cad-jsx.d.ts',
      ...(catalogTypes === undefined ? [] : ['C:/node_modules/@caemble/core/catalog-runtime.d.ts']),
    ],
    options,
    host,
  })
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
}

function diagnosticsFor(
  source: string,
  additionalFiles: Readonly<Record<string, string>> = defaultGeometryFiles,
  sourcePath = 'C:/caemble-source/hash/experiment.tsx',
  catalogTypes?: string,
) {
  return diagnosticsForFiles({ ...additionalFiles, [sourcePath]: source }, catalogTypes)
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
    const prefix = `import { Box, radians, type Geometry } from '@caemble/core'\n`
    const sourcePath = 'C:/caemble-source/hash/geometry.tsx'

    expect(
      diagnosticsFor(
        `${prefix}export const Canonical: Geometry = () => <Box id="body" size={[1, 2, 3]} position={[4, 5, 6]} rotation={radians([10, 20, 30])} scale={[2, 2, 2]} />`,
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

    expect(
      diagnosticsFor(
        `${prefix}export const Wrapped: Geometry = () => <translate offset={[1, 2, 3]}><rotate axis={[0, 0, 1]} angle={1}><scale x={2} y={1} z={1}><Box id="body" size={[1, 1, 1]} /></scale></rotate></translate>`,
        {},
        sourcePath,
      ),
    ).toEqual([])
    expect(
      diagnosticsFor(
        `import { Box as Cuboid, type Geometry } from '@caemble/core'\nexport const Aliased: Geometry = () => <Cuboid id="body" size={[1, 1, 1]} />`,
        {},
        sourcePath,
      ),
    ).toEqual([])
    expect(
      diagnosticsFor(
        `${prefix}export const InvalidWrapper: Geometry = () => <translate offset={[1, 2, 3]} position={[1, 0, 0]}><Box id="body" size={[1, 1, 1]} /></translate>`,
        {},
        sourcePath,
      ).join('\n'),
    ).toContain("Property 'position' does not exist")
  })

  it('type-checks every canonical element example in one TypeScript program', () => {
    const files = Object.fromEntries(
      cadElementCatalog.map((manifest, index) => [
        `C:/caemble-source/catalog/${index}-${manifest.tag}/geometry.tsx`,
        `import { Box, Cylinder, CurvedEdgeCylinder, CurvedSurfaceSphere, Fiber, Sphere, radians, type Geometry } from '@caemble/core'\nexport const Example: Geometry = () => (${manifest.example})`,
      ]),
    )

    expect(diagnosticsForFiles(files)).toEqual([])
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

  it('type-checks every public Geometry example in one TypeScript program', () => {
    const files = Object.fromEntries(
      caembleExamples.flatMap(({ code, id }) => {
        const prefix = `C:/caemble-source/examples/${id}`
        return [
          [`${prefix}/experiment.tsx`, code],
          ...(id === 'dc-conductor'
            ? [
                [`${prefix}/geometry.tsx`, defaultExperimentGeometryCode],
                [`${prefix}/material.tsx`, defaultExperimentMaterialCode],
              ]
            : []),
        ]
      }),
    )

    expect(diagnosticsForFiles(files)).toEqual([])
  })

  it('type-checks every shared Experiment bundle in one TypeScript program', () => {
    const files = Object.fromEntries(
      [...caembleProgramExamples, wheelAssemblyExample].flatMap((example, index) =>
        Object.entries(example.experimentSourceBundle.files)
          .filter(([path]) => path.endsWith('.tsx'))
          .map(([path, source]) => [`C:/caemble-source/programs/${index}-${example.id}/${path}`, source]),
      ),
    )

    expect(diagnosticsForFiles(files)).toEqual([])
  })

  it('type-checks local templates and the AI Helper geometry skeleton in one TypeScript program', () => {
    const files = Object.fromEntries(
      [starterExperimentSourceBundle, blankExperimentSourceBundle, geometryAuthoringSkeletonSourceBundle].flatMap(
        (bundle, index) =>
          Object.entries(bundle.files)
            .filter(([path]) => path.endsWith('.tsx'))
            .map(([path, source]) => [`C:/caemble-source/templates/${index}/${path}`, source]),
      ),
    )

    expect(diagnosticsForFiles(files)).toEqual([])
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
