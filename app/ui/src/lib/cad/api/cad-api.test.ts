import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { defaultCode } from '../../defaultCode'
import { defaultExperimentCode } from '../../defaultExperimentCode'
import { defaultExperimentProgramCode, defaultExperimentTaskCode } from '../../defaultExperimentProgramCode'
import { caembleExamples, caembleProgramExamples } from '../../examples'
import coreTypes from './caemble-core.d.ts?raw'
import jsxTypes from './cad-jsx.d.ts?raw'

const experimentProgramDoc = readFileSync(
  new URL('../../../../../../docs/experiment-program.md', import.meta.url),
  'utf8',
)

function diagnosticsFor(source: string) {
  const sourcePath = 'C:/caemble-source/source.tsx'
  const virtualFiles = new Map<string, string>([
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

  it('type-checks the v4 Structure, Experiment, and Task defaults', () => {
    expect(defaultExperimentCode).toBe(defaultExperimentProgramCode)
    expect(diagnosticsFor(defaultCode)).toEqual([])
    expect(diagnosticsFor(defaultExperimentCode)).toEqual([])
    expect(diagnosticsFor(defaultExperimentTaskCode)).toEqual([])
  })

  it('allows an orchestration-only Experiment without global geometry', () => {
    expect(
      diagnosticsFor(`import { experiment } from '@caemble/core'
      export default experiment({ varsSchema: {}, recordedData: {} })`),
    ).toEqual([])
  })

  it.each(caembleExamples)('type-checks the $title example', ({ code }) => {
    expect(diagnosticsFor(code)).toEqual([])
  })

  it.each(caembleProgramExamples)('type-checks the $title Structure–Experiment pair', (example) => {
    expect(diagnosticsFor(example.structureCode)).toEqual([])
    Object.entries(example.experimentSourceBundle.files)
      .filter(([path]) => path.endsWith('.tsx'))
      .forEach(([, source]) => expect(diagnosticsFor(source)).toEqual([]))
  })

  it('type-checks the complete Structure and Experiment sources in the standalone guide', () => {
    const sources = [...experimentProgramDoc.matchAll(/```tsx\r?\n([\s\S]*?)```/g)].map((match) => match[1])
    expect(sources).toHaveLength(3)
    sources.forEach((source) => expect(diagnosticsFor(source)).toEqual([]))
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
