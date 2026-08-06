import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { defaultCode } from '../../defaultCode'
import { defaultExperimentCode } from '../../defaultExperimentCode'
import { defaultExperimentProgramCode } from '../../defaultExperimentProgramCode'
import { caembleExamples, caembleProgramExamples } from '../../examples'
import experimentProgramDoc from '../../../../docs/experiment-program.md?raw'
import coreTypes from './caemble-core.d.ts?raw'
import jsxTypes from './cad-jsx.d.ts?raw'
import kernelTypes from './caemble-kernels.d.ts?raw'
import { KERNEL_AUTHORING_VERSIONS } from './generatedVersions'

function diagnosticsFor(source: string) {
  const sourcePath = 'C:/caemble-source/source.tsx'
  const virtualFiles = new Map<string, string>([
    [sourcePath, source],
    ['C:/node_modules/@caemble/core/index.d.ts', coreTypes],
    ['C:/node_modules/@caemble/kernels/index.d.ts', kernelTypes],
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
      '@caemble/kernels': ['node_modules/@caemble/kernels/index.d.ts'],
    },
  }
  const host = ts.createCompilerHost(options)
  const defaultFileExists = host.fileExists.bind(host)
  const defaultReadFile = host.readFile.bind(host)
  const defaultDirectoryExists = host.directoryExists?.bind(host)
  host.fileExists = (path) => virtualFiles.has(path.replace(/\\/g, '/')) || defaultFileExists(path)
  host.readFile = (path) => virtualFiles.get(path.replace(/\\/g, '/')) ?? defaultReadFile(path)
  host.directoryExists = (path) =>
    path.replace(/\\/g, '/').startsWith('C:/node_modules/@caemble') || defaultDirectoryExists?.(path) || false
  host.getSourceFile = (path, languageVersion) => {
    const text = host.readFile(path)
    return text === undefined ? undefined : ts.createSourceFile(path, text, languageVersion, true)
  }
  const program = ts.createProgram({
    rootNames: [sourcePath, 'C:/node_modules/@caemble/core/cad-jsx.d.ts'],
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

  it('generates public declarations from both production kernels', () => {
    expect(KERNEL_AUTHORING_VERSIONS).toEqual({
      'dc-current-density': '0.0.0',
      'steady-state-heat': '0.0.0',
    })
  })

  it('type-checks the v3-only Structure and Experiment defaults', () => {
    expect(defaultExperimentCode).toBe(defaultExperimentProgramCode)
    expect(diagnosticsFor(defaultCode)).toEqual([])
    expect(diagnosticsFor(defaultExperimentCode)).toEqual([])
  })

  it('allows an orchestration-only Experiment without fixture geometry', () => {
    expect(
      diagnosticsFor(`
        import { experiment } from '@caemble/core'
        import { dcCurrentDensity } from '@caemble/kernels'
        export default experiment({
          varsSchema: {},
          tasks: () => ({
            electric: dcCurrentDensity({
              parameters: {
                relativeTolerance: {
                  dtype: 'float64',
                  value: 1e-8,
                  unit: '{fraction}',
                  quantityKind: 'DimensionlessRatio',
                },
                maxIterations: 2000,
              },
              initializations: [{
                methodId: 'dc.voxel-grid',
                target: ['structure.geometry.conductor'],
                parameters: { gridShape: { dtype: 'int32', axes: [{ length: 3 }], value: [10, 4, 4] } },
              }],
              boundaryConditions: [{
                methodId: 'dc.source-potential',
                target: ['structure.surface.sourceTerminal'],
                parameters: { voltage: { dtype: 'float64', value: 1, unit: 'mV', quantityKind: 'electromagnetism.Voltage' } },
              }, {
                methodId: 'dc.reference-potential',
                target: ['structure.surface.referenceTerminal'],
                parameters: { voltage: { dtype: 'float64', value: 0, unit: 'mV', quantityKind: 'electromagnetism.Voltage' } },
              }],
              outputs: [{
                key: 'current',
                methodId: 'dc.total-current',
                target: ['structure.geometry.conductor'],
                parameters: { crossSectionPosition: { dtype: 'float64', value: 0.5, unit: '{fraction}', quantityKind: 'DimensionlessRatio' } },
              }],
            }),
          }),
          recordedData: {},
          simulate: ({ sim }) => sim.initialState,
        })
      `),
    ).toEqual([])
  })

  it.each(caembleExamples)('type-checks the $title example', ({ code }) => {
    expect(diagnosticsFor(code)).toEqual([])
  })

  it.each(caembleProgramExamples)('type-checks the $title Structure–Experiment pair', (example) => {
    expect(diagnosticsFor(example.structureCode)).toEqual([])
    expect(diagnosticsFor(example.experimentCode)).toEqual([])
  })

  it('type-checks the complete Structure and Experiment sources in the standalone guide', () => {
    const sources = [...experimentProgramDoc.matchAll(/```tsx\r?\n([\s\S]*?)```/g)].map((match) => match[1])
    expect(sources).toHaveLength(2)
    sources.forEach((source) => expect(diagnosticsFor(source)).toEqual([]))
  })

  it('rejects unknown vars and tuple shapes', () => {
    const unknownVar = defaultCode.replace('size={vars.conductorSize}', 'size={vars.unknownSize}')
    const wrongTuple = defaultCode.replace('size={vars.conductorSize}', 'size={[1, 2]}')

    expect(diagnosticsFor(unknownVar).join('\n')).toContain("Property 'unknownSize' does not exist")
    expect(diagnosticsFor(wrongTuple).join('\n')).toContain('Source has 2 element(s) but target requires 3')
  })

  it('rejects unknown kernel methods and parameter keys', () => {
    const wrongMethod = defaultExperimentProgramCode.replace("methodId: 'dc.voxel-grid'", "methodId: 'dc.unknown'")
    const wrongParameter = defaultExperimentProgramCode.replace('gridShape: {', 'unknownGridShape: {')

    expect(diagnosticsFor(wrongMethod).join('\n')).toContain('dc.unknown')
    expect(diagnosticsFor(wrongParameter).join('\n')).toContain('unknownGridShape')
  })

  it('infers task-local artifact keys and global RecordedData names', () => {
    const unknownArtifact = defaultExperimentProgramCode.replace(
      'electric.artifacts.totalCurrent',
      'electric.artifacts.unknown',
    )
    const unknownRecordedData = defaultExperimentProgramCode.replace(
      "sim.record('measuredCurrent'",
      "sim.record('unknown'",
    )

    expect(diagnosticsFor(unknownArtifact).join('\n')).toContain("Property 'unknown' does not exist")
    expect(diagnosticsFor(unknownRecordedData).join('\n')).toContain('Argument of type \'"unknown"\' is not assignable')
  })

  it('preserves required, optional, unknown, and typed kernel input ports', () => {
    const program = (inputs: string, runInput: string) => `
      import {
        experiment,
        type ArtifactRef,
        type DefinedKernelTask,
      } from '@caemble/core'

      declare const consumer: DefinedKernelTask<
        {},
        Readonly<{ done: 'test/done@1' }>,
        Readonly<Record<never, never>>,
        ${inputs}
      >
      declare const source: ArtifactRef<'test/source@1'>
      declare const other: ArtifactRef<'test/other@1'>

      export default experiment({
        lengthUnit: 'mm',
        varsSchema: {},
        geometry: () => <box size={[1, 1, 1]} />,
        tasks: () => ({ consumer }),
        recordedData: {
          done: { dtype: 'float64', unit: 'A', quantityKind: 'electromagnetism.ElectricCurrent' },
        },
        simulate: async ({ sim, tasks }) => {
          const result = await sim.run(tasks.consumer${runInput})
          sim.record('done', result.artifacts.done)
          return result.state
        },
      })
    `

    expect(diagnosticsFor(program(`Readonly<{ source: 'test/source@1' }>`, `, { inputs: { source } }`))).toEqual([])
    expect(diagnosticsFor(program(`Readonly<{ source: 'test/source@1' | undefined }>`, ''))).toEqual([])
    expect(diagnosticsFor(program(`Readonly<{ source: 'test/source@1' }>`, '')).join('\n')).toContain(
      'Expected 2 arguments',
    )
    expect(
      diagnosticsFor(program(`Readonly<{ source: 'test/source@1' }>`, `, { inputs: { unknown: source } }`)).join('\n'),
    ).toContain('unknown')
    expect(
      diagnosticsFor(program(`Readonly<{ source: 'test/source@1' }>`, `, { inputs: { source: other } }`)).join('\n'),
    ).toContain('test/other@1')
  })

  it('keeps canonical Material property and model authoring types strict', () => {
    expect(kernelTypes).toContain("'electrical.conductivity': MaterialDataValueDescriptor<'electrical.conductivity'>")
    expect(kernelTypes).toContain("'thermal.conductivity': MaterialDataValueDescriptor<'thermal.conductivity'>")
    expect(coreTypes).toContain("'model.sorption.isotherm': Readonly<{")
    expect(coreTypes).toContain('{ color?: string; errorRate?: number }')
    expect(coreTypes).toContain('readonly errorRate: number')

    const localKey = defaultCode.replace("'electrical.conductivity': {", 'electricalConductivity: {')
    const arbitraryKey = defaultCode.replace("'electrical.conductivity': {", "'custom.conductivity': {")
    const manualQuantityKind = defaultCode.replace(
      "unit: 'S.m-1',",
      "unit: 'S.m-1',\n            quantityKind: 'electromagnetism.ElectricConductivity',",
    )
    expect(diagnosticsFor(localKey).join('\n')).toContain('electricalConductivity')
    expect(diagnosticsFor(arbitraryKey).join('\n')).toContain('custom.conductivity')
    expect(diagnosticsFor(manualQuantityKind).join('\n')).toContain(
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
