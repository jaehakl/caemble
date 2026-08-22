import { describe, expect, it } from 'vitest'
import { resolveExperimentModuleSpecifier } from './moduleResolution'
import { assertExperimentModuleGraph } from './sourceAnalysis'

const coreFiles = {
  'experiment.tsx': `import { experiment } from '@caemble/core'
export default experiment({ lengthUnit: 'mm', varsSchema: {}, geometry: () => null, recordedData: {} })`,
  'geometry.tsx': 'export {}',
  'material.tsx': 'export {}',
}

describe('Experiment bundle module graph', () => {
  it('resolves explicit TS/TSX paths and extensionless files or index modules', () => {
    const files = {
      ...coreFiles,
      'shared/direct.ts': 'export const direct = 1',
      'shared/view.tsx': 'export const View = () => null',
      'shared/group/index.ts': 'export const grouped = 1',
    }
    expect(resolveExperimentModuleSpecifier(files, 'experiment.tsx', './shared/direct.ts')).toBe('shared/direct.ts')
    expect(resolveExperimentModuleSpecifier(files, 'experiment.tsx', './shared/view')).toBe('shared/view.tsx')
    expect(resolveExperimentModuleSpecifier(files, 'experiment.tsx', './shared/group')).toBe('shared/group/index.ts')
  })

  it('accepts static import and re-export forms across helper modules', () => {
    expect(() =>
      assertExperimentModuleGraph({
        ...coreFiles,
        'shared/value.ts': 'export default 1; export const named = 2',
        'shared/barrel.ts': `export { default as value, named } from './value'
export * from './types'`,
        'shared/types.ts': 'export type Item = { value: number }',
        'shared/consumer.ts': `import value, { named } from './value'
import * as barrel from './barrel'
import './types'
export const total = value + named + barrel.named`,
      }),
    ).not.toThrow()
  })

  it('rejects missing, ambiguous, escaping, external, dynamic, and require dependencies', () => {
    const ambiguous = { ...coreFiles, 'shared/item.ts': 'export {}', 'shared/item.tsx': 'export {}' }
    expect(() => resolveExperimentModuleSpecifier(ambiguous, 'experiment.tsx', './shared/item')).toThrow('ambiguous')
    expect(() => resolveExperimentModuleSpecifier(coreFiles, 'experiment.tsx', './missing')).toThrow('unresolved')
    expect(() => resolveExperimentModuleSpecifier(coreFiles, 'experiment.tsx', '../escape')).toThrow('escapes')
    expect(() => assertExperimentModuleGraph({ ...coreFiles, 'shared/x.ts': "export * from 'package'" })).toThrow(
      'bundle-relative',
    )
    expect(() => assertExperimentModuleGraph({ ...coreFiles, 'shared/x.ts': "void import('./value')" })).toThrow(
      'Dynamic import',
    )
    expect(() =>
      assertExperimentModuleGraph({ ...coreFiles, 'shared/x.ts': "declare const require: any\nrequire('./value')" }),
    ).toThrow('require')
  })

  it('rejects runtime cycles but permits type-only dependency cycles', () => {
    expect(() =>
      assertExperimentModuleGraph({
        ...coreFiles,
        'shared/a.ts': "export { b } from './b'",
        'shared/b.ts': "export { a } from './a'",
      }),
    ).toThrow('cycle')
    expect(() =>
      assertExperimentModuleGraph({
        ...coreFiles,
        'shared/a.ts': "export type { B } from './b'\nexport type A = string",
        'shared/b.ts': "export type { A } from './a'\nexport type B = string",
      }),
    ).not.toThrow()
  })

  it('parses .ts modules as TypeScript and .tsx modules as TSX', () => {
    expect(() =>
      assertExperimentModuleGraph({ ...coreFiles, 'shared/value.ts': 'export const value = <number>1' }),
    ).not.toThrow()
    expect(() =>
      assertExperimentModuleGraph({ ...coreFiles, 'shared/value.tsx': 'export const value = <number>1' }),
    ).toThrow()
  })
})
