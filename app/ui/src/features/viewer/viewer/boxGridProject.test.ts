import { analyzeCalculationSource } from '@/lib/calculation/sourcePolicy'
import { describe, expect, it } from 'vitest'
import { calculationExampleInput } from '@/authoring/examples'
import { projectBoxGrid, projectionCode, type BoxGridProjectionOptions } from '@/lib/calculation/boxGridProject'
import type { CalculationInputLeaf } from '@/lib/calculation/types'
import { normalizeCalculationOutput, normalizeCalculationRunnerOutput } from '@/lib/calculation/validation'
import { executeCalculation } from '@/lib/calculation/execute'
import { transformCalculationSource } from '@/lib/calculation/transform'
import { analyzeCalculationDependencies } from '@/lib/calculation/dependencies'
import { scalarPlotData, calculateBoxGridView } from '@/features/viewer/viewer/boxGridViewData'

const leaf: CalculationInputLeaf = {
  ...calculationExampleInput.signal,
  shape: [2, 2, 1, 2, 1, 1, 1],
  data: [1, 3, 5, 7, 9, 11, 13, 15],
  axes: [
    { name: 'x', ticks: [0.25, 0.75], unit: 'm' },
    { name: 'y', ticks: [0.25, 0.75], unit: 'm' },
    { name: 'z', ticks: [0.5], unit: 'm' },
    { name: 'time', ticks: [0, 1], unit: 's' },
    ...calculationExampleInput.signal.axes.slice(4),
  ],
  boxGrid: { ...calculationExampleInput.signal.boxGrid, gridShape: [2, 2, 1] },
}

function harmonicLeaf(frequencies: number[], data: number[], components = ['value']): CalculationInputLeaf {
  return {
    ...calculationExampleInput.signal,
    shape: [1, 1, 1, 1, frequencies.length, 2, components.length],
    data,
    tensorOrder: components.length === 1 ? 0 : 1,
    axes: [
      ...calculationExampleInput.signal.axes.slice(0, 4).map((axis) => ({ ...axis, ticks: [axis.ticks[0]] })),
      { name: 'frequency', ticks: frequencies, unit: 'Hz' },
      { name: 'amplitudePhase', ticks: ['amplitude', 'phase'] },
      { name: 'component', ticks: components },
    ],
    boxGrid: {
      ...calculationExampleInput.signal.boxGrid,
      components,
      channels: ['amplitude', 'phase'],
      channelUnits: ['1', 'rad'],
    },
  }
}

describe('Common-time frequency synthesis', () => {
  it.each([
    ['sum', -1],
    ['mean', -0.5],
  ] as const)('evolves 1 Hz and 2 Hz independently before %s', (method, expected) => {
    const input = harmonicLeaf([1, 2], [1, 0, 1, 0])
    const options: BoxGridProjectionOptions = {
      axes: [],
      component: 0,
      reduce: { frequency: { method } },
      frame: { timeSeconds: 0.25 },
    }
    expect(projectBoxGrid(input, options).data).toBeCloseTo(expected)
    expect(projectBoxGrid(input, { ...options, frame: { phase: Math.PI / 2 } }).data).toBeCloseTo(0)
    const source = `export default function calculate(samples) { return ${projectionCode("samples['signal']", options)}; }`
    expect(
      executeCalculation(
        transformCalculationSource(source, 'test', analyzeCalculationSource(source)),
        { signal: input },
        () => {},
      ),
    ).toEqual(normalizeCalculationOutput(projectBoxGrid(input, options)))
  })

  it('preserves initial phase and DC, converts kHz, and honors frequency selection and retained axes', () => {
    const base = harmonicLeaf([0, 1, 2], [2, -Math.PI / 3, 1, -Math.PI / 2, 1, 0])
    const input = { ...base, axes: base.axes.map((axis, index) => (index === 4 ? { ...axis, unit: 'kHz' } : axis)) }
    const options: BoxGridProjectionOptions = { axes: [], component: 0, frame: { timeSeconds: 0.00025 } }
    expect(projectBoxGrid(input, { ...options, reduce: { frequency: { method: 'sum' } } }).data).toBeCloseTo(1)
    expect(projectBoxGrid(input, { ...options, reduce: { frequency: { method: 'mean' } } }).data).toBeCloseTo(1 / 3)
    expect(
      projectBoxGrid(input, { ...options, reduce: { frequency: { method: 'index', index: 0 } } }).data,
    ).toBeCloseTo(1)
    const retained = projectBoxGrid(input, { ...options, axes: ['frequency'] }).data as number[]
    retained.forEach((value, index) => expect(value).toBeCloseTo([1, 1, -1][index]))
    expect(
      projectBoxGrid(input, { ...options, frame: { timeSeconds: 0.00025, axis: 'frequency', index: 1 } }).data,
    ).toBeCloseTo(1)
    expect(projectBoxGrid(harmonicLeaf([2], [3, 0]), { ...options, frame: { timeSeconds: 0.25 } }).data).toBeCloseTo(-3)
  })

  it.each(['sum', 'mean'] as const)(
    'synthesizes vector components before magnitude for %s, including arrows and bounds',
    (method) => {
      const input = harmonicLeaf([1, 2], [3, 4, 0, 0, 0, 0, 3, 4, 0, -Math.PI, -Math.PI, 0], ['x', 'y', 'z'])
      const options: BoxGridProjectionOptions = {
        axes: ['x', 'y', 'z'],
        component: 'magnitude',
        reduce: { frequency: { method } },
        frame: { timeSeconds: 0 },
      }
      const cancelled = calculateBoxGridView({ leaf: input, options, arrows: true, animationRange: true })
      expect(cancelled.scalar.values[0]).toBeCloseTo(0)
      expect(Math.hypot(...cancelled.vectors!.map((values) => values[0]))).toBeCloseTo(0)
      const reinforced = calculateBoxGridView({
        leaf: input,
        options: { ...options, frame: { timeSeconds: 0.5 } },
        arrows: true,
        animationRange: true,
      })
      expect(reinforced.scalar.values[0]).toBeCloseTo(method === 'sum' ? 10 : 5)
      expect(Math.hypot(...reinforced.vectors!.map((values) => values[0]))).toBeCloseTo(reinforced.scalar.values[0])
      expect(cancelled.scalar.range).toEqual(reinforced.scalar.range)
      expect(cancelled.scalar.range[1]).toBeGreaterThanOrEqual(reinforced.scalar.values[0])
      const expressions = projectionCode(
        "samples['signal']",
        { ...options, frame: { timeSeconds: 0.5 } },
        [0, 1, 2],
      ).split('\n')
      for (const [index, expression] of expressions.entries()) {
        const source = `export default function calculate(samples) { return ${expression}\n }`
        const output = executeCalculation(
          transformCalculationSource(source, 'test', analyzeCalculationSource(source)),
          { signal: input },
          () => {},
        )
        expect(scalarPlotData(output).values).toEqual(index < 3 ? reinforced.vectors![index] : reinforced.scalar.values)
      }
    },
  )

  it('reduces frequency before nonlinear spatial reductions only for time sum/mean', () => {
    const base = harmonicLeaf([1, 2], [1, 0, 1, -Math.PI, 1, 0, 1, 0])
    const input = {
      ...base,
      shape: [2, 1, 1, 1, 2, 2, 1],
      axes: base.axes.map((axis, index) => (index === 0 ? { ...axis, ticks: [0, 1] } : axis)),
      boxGrid: { ...base.boxGrid, gridShape: [2, 1, 1] as const },
    }
    const options: BoxGridProjectionOptions = {
      axes: [],
      component: 'magnitude',
      reduce: { x: { method: 'min' }, frequency: { method: 'sum' } },
      frame: { timeSeconds: 0 },
    }
    expect(projectBoxGrid(input, options).data).toBeCloseTo(0)
    expect(projectBoxGrid(input, { ...options, component: 0 }).data).toBeCloseTo(0)
    expect(projectBoxGrid(input, { ...options, frame: undefined }).data).toBeCloseTo(2)
    expect(projectBoxGrid(input, { ...options, frame: { phase: 0 } }).data).toBeCloseTo(2)
    expect(projectBoxGrid(input, { ...options, reduce: { frequency: { method: 'max' } } }).data).toBeCloseTo(1)
  })

  it('rejects conflicting frames, invalid times, real channels and missing or incompatible frequency units', () => {
    const input = harmonicLeaf([1], [1, 0])
    for (const frame of [{ timeSeconds: NaN }, { timeSeconds: Infinity }, { timeSeconds: 0, phase: 0 }])
      expect(() => projectBoxGrid(input, { axes: [], frame })).toThrow()
    expect(() => projectBoxGrid(leaf, { axes: [], frame: { timeSeconds: 0 } })).toThrow(/진폭/)
    for (const unit of [undefined, 'm']) {
      const invalid = { ...input, axes: input.axes.map((axis, index) => (index === 4 ? { ...axis, unit } : axis)) }
      expect(() => projectBoxGrid(invalid, { axes: [], frame: { timeSeconds: 0 } })).toThrow()
    }
  })
})
describe('Box Grid projection', () => {
  it.each([
    ['sum', 16],
    ['mean', 8],
    ['min', 4],
    ['max', 12],
    ['median', 8],
    ['std', 4],
  ] as const)('reduces x using %s before averaging other axes', (method, expected) => {
    expect(projectBoxGrid(leaf, { axes: [], reduce: { x: { method } } }).data).toBe(expected)
  })
  it('uses canonical mixed reduction order, reorders kept axes and preserves singleton axes', () => {
    expect(projectBoxGrid(leaf, { axes: [], reduce: { x: { method: 'min' }, y: { method: 'max' } } }).data).toBe(6)
    const result = projectBoxGrid(leaf, { axes: ['time', 'x', 'z'], reduce: { y: { method: 'index', index: 1 } } })
    expect(result.data).toEqual([
      [[5], [13]],
      [[7], [15]],
    ])
    expect(result.axes.map((axis) => axis.name)).toEqual(['time', 'x', 'z'])
    expect(normalizeCalculationOutput(result).shape).toEqual([2, 2, 1])
  })
  it('preserves five continuous axes in Histogram and keeps a frozen sweep axis at length one', () => {
    const output = projectBoxGrid(leaf, {
      axes: ['x', 'y', 'z', 'time', 'frequency'],
      frame: { axis: 'time', index: 1 },
    })
    expect(output.axes.map((axis) => axis.ticks.length)).toEqual([2, 2, 1, 1, 1])
    expect(scalarPlotData(output).values).toEqual([3, 7, 11, 15])
    expect(() => normalizeCalculationOutput(output)).toThrow(/rank/)
    expect(
      projectBoxGrid(leaf, { axes: [], reduce: { time: { method: 'std' } }, frame: { axis: 'time', index: 1 } }).data,
    ).toBe(9)
  })
  it('projects vector magnitude before averaging, with phase and zero-frequency handling', () => {
    const vector: CalculationInputLeaf = {
      ...calculationExampleInput.signal,
      shape: [1, 1, 1, 2, 1, 2, 3],
      data: [3, 4, 0, 0, 0, 0, 3, 4, 0, -Math.PI, -Math.PI, 0],
      tensorOrder: 1,
      axes: [
        ...calculationExampleInput.signal.axes.slice(0, 3),
        { name: 'time', ticks: [0, 1], unit: 's' },
        { name: 'frequency', ticks: [1], unit: 'Hz' },
        { name: 'amplitudePhase', ticks: ['amplitude', 'phase'] },
        { name: 'component', ticks: ['x', 'y', 'z'] },
      ],
      boxGrid: {
        ...calculationExampleInput.signal.boxGrid,
        components: ['x', 'y', 'z'],
        channels: ['amplitude', 'phase'],
        channelUnits: ['1', 'rad'],
      },
    }
    expect(projectBoxGrid(vector, { axes: [], component: 'magnitude', frame: { phase: 0 } }).data).toBe(5)
    expect(projectBoxGrid(vector, { axes: [], component: 0, frame: { phase: 0 } }).data).toBe(0)
    expect(projectBoxGrid(vector, { axes: [], component: 1, representation: 'phase' }).data).toBe(-Math.PI / 2)
    expect(() => projectBoxGrid(vector, { axes: [], component: 'magnitude', representation: 'phase' })).toThrow(/Phase/)
    const dc = { ...vector, axes: vector.axes.map((axis, i) => (i === 4 ? { ...axis, ticks: [0] } : axis)) }
    expect(projectBoxGrid(dc, { axes: [], component: 'magnitude', frame: { phase: Math.PI / 2 } }).data).toBe(5)
    const options: BoxGridProjectionOptions = { axes: ['x', 'y', 'z'], component: 'magnitude', frame: { phase: 0 } }
    const copied = projectionCode("samples['signal']", options, [0, 1, 2]).split('\n')
    expect(copied).toHaveLength(4)
    for (const [index, expression] of copied.entries()) {
      const source = `export default function calculate(samples) { return ${expression}\n }`
      const expected = projectBoxGrid(vector, { ...options, component: index < 3 ? index : 'magnitude' })
      expect(
        executeCalculation(
          transformCalculationSource(source, 'test', analyzeCalculationSource(source)),
          { signal: vector },
          () => {},
        ),
      ).toEqual(normalizeCalculationOutput(expected))
    }
  })
  it.each([
    { axes: ['x', 'x'] },
    { axes: [], component: 5 },
    { axes: [], reduce: { x: { method: 'index', index: 2 } } },
    { axes: [], reduce: { x: { method: 'index', index: -1 } } },
    { axes: [], frame: { axis: 'time', index: 0.5 } },
  ])('rejects invalid selectors %j', (options) =>
    expect(() => projectBoxGrid(leaf, options as BoxGridProjectionOptions)).toThrow(),
  )
  it('executes copied projections through dependency analysis and the shared Calculation runtime', () => {
    const options: BoxGridProjectionOptions = { axes: ['x', 'y', 'time'], component: 0 }
    const source = `export default function calculate(samples) { return ${projectionCode("samples['group.signal']", options)}; }`
    expect(analyzeCalculationDependencies(source, ['group.signal'])).toEqual(['group.signal'])
    const actual = executeCalculation(
      transformCalculationSource(source, 'test', analyzeCalculationSource(source)),
      { 'group.signal': leaf },
      () => {},
    )
    expect(actual).toEqual(normalizeCalculationOutput(projectBoxGrid(leaf, options)))
    expect(scalarPlotData(actual)).toEqual(
      calculateBoxGridView({ leaf, options, arrows: false, animationRange: false }).scalar,
    )
    expect(normalizeCalculationRunnerOutput(actual)).toEqual(actual)
  })
  it('rejects ragged, non-finite and rank-four outputs while retaining empty rank-three matrices', () => {
    expect(() => normalizeCalculationOutput({ dtype: 'float64', data: [[[1]], [[1, 2]]] })).toThrow(/ragged/)
    expect(() => normalizeCalculationOutput({ dtype: 'float64', data: [[[Infinity]]] })).toThrow(/finite/)
    expect(() => normalizeCalculationOutput({ dtype: 'float64', data: [[[[1]]]] })).toThrow(/rank/)
    expect(normalizeCalculationOutput({ dtype: 'float64', data: [[[]]] }).shape).toEqual([1, 1, 0])
  })
})
