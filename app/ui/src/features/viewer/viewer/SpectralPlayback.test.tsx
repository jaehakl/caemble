import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RecordedResultContract } from '@/contracts/results'
import type { DataSchema, RecordedDataRule } from '@/lib/cad/model'
import { createDataTensor } from '@/lib/cad/model/dataTensor'
import { StructuredFieldResult } from './StructuredFieldResult'
import { fieldRange, oscillateSlice, oscillationSlice, structuredField } from './structuredField'

vi.mock('./ResultTensorView', () => ({ ResultTensorView: () => <div>2D 상세</div> }))

const schema: DataSchema = {
  dtype: 'complex64',
  unit: 'V.m-1',
  quantityKind: 'electromagnetism.ElectricFieldStrength',
  axes: [
    { name: 'frequency', unit: 'Hz', quantityKind: 'Frequency' },
    ...['z', 'y', 'x'].map((name) => ({ name, unit: 'm', quantityKind: 'Length' })),
  ],
}
const tensor = createDataTensor(schema, {
  value: [
    [
      [
        [
          [
            { re: 3, im: 4 },
            { re: 0, im: 0 },
            { re: 1, im: 0 },
          ],
        ],
      ],
    ],
    [
      [
        [
          [
            { re: 2, im: 0 },
            { re: 0, im: 0 },
            { re: 0, im: 0 },
          ],
        ],
      ],
    ],
  ],
  axes: [{ ticks: [3e14, 0] }, ...[0, 1, 2].map(() => ({ ticks: [0], bounds: [-1, 1] as const }))],
})
const contract: RecordedResultContract = {
  task: 'reference',
  output: 'field',
  solver: { name: 'fdtd', version: '4.0.0' },
  artifactType: 'fixture',
  catalogRevision: 'fixture',
  schema,
  visualization: {
    kind: 'structured-field',
    components: ['Ex', 'Ey', 'Ez'],
    grid: { xyzAxes: [3, 2, 1], sampleAxis: 0, sampleKind: 'frequency', componentAxis: 4 },
  },
}
const rules: RecordedDataRule[] = [{ label: 'field', result: schema, target: [], parameters: {}, methodId: '' }]
let callbacks: Map<number, FrameRequestCallback>
let now = 0
beforeEach(() => {
  callbacks = new Map()
  let id = 0
  now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('oscillates cached phasors at quarter cycles with fixed range and unchanged topology', () => {
  const field = structuredField(schema, tensor, contract.visualization, 'm')
  const cache = oscillationSlice(field, 'field', 2, 0, 0, 0)
  const amplitude = fieldRange(field, 0, 0, 'abs')[1]
  expect(amplitude).toBe(5)
  for (const [phase, expected] of [
    [0, 3],
    [90, -4],
    [180, -3],
    [360, 3],
  ]) {
    const scene = oscillateSlice(cache, phase, [-amplitude, amplitude], 0.8)
    expect(scene.geometries[0].colors[0] * 10 - 5).toBeCloseTo(expected, 5)
    expect(scene.geometries[0].positions).toBe(cache.scene.geometries[0].positions)
    expect(scene.geometries[0].indices).toBe(cache.scene.geometries[0].indices)
    expect(scene.bounds).toBe(cache.scene.bounds)
  }
  expect([...cache.phasors]).toEqual([3, 4])
})

it('starts paused, seeks and resets frequency, stops on details/static/unmount and disables DC playback', () => {
  const view = render(
    <StructuredFieldResult
      name="field"
      contract={contract}
      rules={rules}
      data={{ field: tensor }}
      displayUnit="m"
      renderViewer={() => <div>scene</div>}
    />,
  )
  fireEvent.change(screen.getByLabelText('장 표시 모드'), { target: { value: 'oscillating' } })
  expect(screen.getByRole('combobox', { name: /^성분/ })).toHaveValue('-1')
  expect(screen.getByLabelText('진동 위상')).toHaveValue('0')
  expect(callbacks.size).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: '재생' }))
  act(() => {
    now = 500
    const active = [...callbacks.values()]
    callbacks.clear()
    active.forEach((callback) => callback(now))
  })
  expect(screen.getByLabelText('진동 위상')).toHaveValue('90')
  fireEvent.change(screen.getByRole('combobox', { name: /^성분/ }), { target: { value: '1' } })
  expect(screen.getByLabelText('진동 위상')).toHaveValue('90')
  expect(screen.getByText(/영장/)).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('진동 위상'), { target: { value: '180' } })
  expect(callbacks.size).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: '재생' }))
  fireEvent.change(screen.getByLabelText(/^주파수 \/ 진공 파장/), { target: { value: '1' } })
  expect(screen.getByLabelText('진동 위상')).toHaveValue('0')
  expect(screen.getByRole('button', { name: '재생' })).toBeDisabled()
  expect(callbacks.size).toBe(0)
  fireEvent.change(screen.getByLabelText(/^주파수 \/ 진공 파장/), { target: { value: '0' } })
  fireEvent.click(screen.getByRole('button', { name: '재생' }))
  fireEvent.click(screen.getByLabelText(/Table \/ 2D/))
  expect(callbacks.size).toBe(0)
  fireEvent.click(screen.getByLabelText(/Table \/ 2D/))
  fireEvent.click(screen.getByRole('button', { name: '재생' }))
  fireEvent.change(screen.getByLabelText('장 표시 모드'), { target: { value: 'static' } })
  expect(callbacks.size).toBe(0)
  fireEvent.change(screen.getByLabelText('장 표시 모드'), { target: { value: 'oscillating' } })
  fireEvent.click(screen.getByRole('button', { name: '재생' }))
  view.unmount()
  expect(callbacks.size).toBe(0)
})

it('keeps separate static and oscillation manual ranges and resets a different result', () => {
  const props = {
    name: 'field',
    contract,
    rules,
    data: { field: tensor },
    displayUnit: 'm',
    renderViewer: () => <div>scene</div>,
  }
  const view = render(<StructuredFieldResult {...props} />)
  fireEvent.click(screen.getByLabelText('색상 범위 고정'))
  fireEvent.change(screen.getByLabelText('색상 최댓값'), { target: { value: '12' } })
  fireEvent.change(screen.getByLabelText('장 표시 모드'), { target: { value: 'oscillating' } })
  fireEvent.change(screen.getByRole('combobox', { name: /^성분/ }), { target: { value: '0' } })
  expect(screen.getByLabelText('색상 범위 고정')).not.toBeChecked()
  fireEvent.click(screen.getByLabelText('색상 범위 고정'))
  expect(screen.getByLabelText('색상 최솟값')).toHaveValue(-5)
  expect(screen.getByLabelText('색상 최댓값')).toHaveValue(5)
  fireEvent.change(screen.getByLabelText('장 표시 모드'), { target: { value: 'static' } })
  expect(screen.getByLabelText('색상 최댓값')).toHaveValue(12)
  fireEvent.change(screen.getByLabelText('장 표시 모드'), { target: { value: 'oscillating' } })
  fireEvent.click(screen.getByRole('button', { name: '재생' }))
  view.rerender(
    <StructuredFieldResult
      {...props}
      name="other"
      rules={[{ ...rules[0], label: 'other' }]}
      data={{ other: tensor }}
    />,
  )
  expect(callbacks.size).toBe(0)
  expect(screen.getByLabelText('장 표시 모드')).toHaveValue('static')
})


it('preserves oscillation settings but stops playback and clamps the sample on data replacement', () => {
  const props = { name: 'field', contract, rules, displayUnit: 'm' as const, renderViewer: () => <div>slice</div> }
  const { rerender } = render(<StructuredFieldResult {...props} data={{ field: tensor }} />)
  fireEvent.change(screen.getByLabelText('장 표시 모드'), { target: { value: 'oscillating' } })
  fireEvent.click(screen.getByText('재생'))
  expect(screen.getByText('일시정지')).toBeInTheDocument()
  rerender(<StructuredFieldResult {...props} data={{ field: { ...tensor } }} />)
  expect(screen.getByText('재생')).toBeInTheDocument()
  expect(screen.getByLabelText('장 표시 모드')).toHaveValue('oscillating')
  expect(screen.getByLabelText('반복')).toBeChecked()
  fireEvent.change(screen.getByLabelText('주파수 / 진공 파장'), { target: { value: '1' } })
  const smaller = { ...tensor, shape: [1, ...tensor.shape.slice(1)], axes: [{ ticks: [3e14] }, ...tensor.axes!.slice(1)] }
  rerender(<StructuredFieldResult {...props} data={{ field: smaller }} />)
  expect(screen.getByLabelText('주파수 / 진공 파장')).toHaveValue('0')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})


it.each([
  { label: 'in-phase linear', re: [3, 4, 0], im: [0, 0, 0], peak: 5, values: [5, 0, 5, 5], frequency: 1 },
  { label: 'phase-shifted elliptical', re: [2, 0, 0], im: [0, 1, 0], peak: 2, values: [2, 1, 2, 2], frequency: 1 },
  { label: 'circular', re: [1, 0, 0], im: [0, 1, 0], peak: 1, values: [1, 1, 1, 1], frequency: 1 },
  { label: 'non-orthogonal phasors', re: [3, 0, 0], im: [4, 0, 0], peak: 5, values: [3, 4, 3, 3], frequency: 1 },
  { label: 'DC', re: [3, 4, 0], im: [20, 0, 0], peak: 5, values: [5, 5, 5, 5], frequency: 0 },
  { label: 'zero field', re: [0, 0, 0], im: [0, 0, 0], peak: 0, values: [0, 0, 0, 0], frequency: 1 },
])('computes instantaneous vector magnitude and analytic maximum: $label', ({ re, im, peak, values, frequency }) => {
  const data = createDataTensor(schema, {
    value: [[[[re.map((value, i) => ({ re: value, im: im[i] }))]]]],
    axes: [{ ticks: [frequency] }, ...[0, 1, 2].map(() => ({ ticks: [0], bounds: [-1, 1] as const }))],
  })
  const field = structuredField(schema, data, contract.visualization, 'm')
  expect(fieldRange(field, 0, -1, 'peak')[1]).toBeCloseTo(peak)
  const cache = oscillationSlice(field, 'magnitude', 2, 0, 0, -1)
  expect(cache.phasors.length).toBe(6)
  for (const [index, phase] of [0, 90, 180, 360].entries()) {
    const scene = oscillateSlice(cache, frequency === 0 ? 0 : phase, [0, peak || 1], 0.8)
    expect(scene.geometries[0].colors[0] * (peak || 1)).toBeCloseTo(values[index], 5)
    expect(scene.geometries[0].positions).toBe(cache.scene.geometries[0].positions)
    expect(scene.geometries[0].indices).toBe(cache.scene.geometries[0].indices)
  }
})

it('retains total magnitude and phase, separates manual ranges, and opens formula help with keyboard focus', async () => {
  render(<StructuredFieldResult name="field" contract={contract} rules={rules} data={{ field: tensor }} displayUnit="m" renderViewer={() => <div>scene</div>} />)
  fireEvent.change(screen.getByLabelText('장 표시 모드'), { target: { value: 'oscillating' } })
  expect(screen.getByRole('combobox', { name: /^성분/ })).toHaveValue('-1')
  fireEvent.change(screen.getByLabelText('진동 위상'), { target: { value: '90' } })
  fireEvent.click(screen.getByLabelText('색상 범위 고정'))
  expect(screen.getByLabelText('색상 최솟값')).toHaveValue(0)
  const maximum = (screen.getByLabelText('색상 최댓값') as HTMLInputElement).value
  fireEvent.change(screen.getByLabelText('진동 위상'), { target: { value: '180' } })
  expect(screen.getByLabelText('색상 최댓값')).toHaveValue(Number(maximum))
  fireEvent.change(screen.getByLabelText('색상 최솟값'), { target: { value: '-1' } })
  expect(screen.getByLabelText('색상 최솟값')).toHaveValue(0)
  fireEvent.change(screen.getByLabelText('색상 최댓값'), { target: { value: '12' } })
  fireEvent.change(screen.getByRole('combobox', { name: /^성분/ }), { target: { value: '0' } })
  expect(screen.getByLabelText('색상 범위 고정')).not.toBeChecked()
  expect(screen.getByLabelText('진동 위상')).toHaveValue('180')
  fireEvent.change(screen.getByRole('combobox', { name: /^성분/ }), { target: { value: '-1' } })
  expect(screen.getByLabelText('색상 최댓값')).toHaveValue(12)
  fireEvent.focus(screen.getByRole('button', { name: '성분 수식 도움말' }))
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Re(Fᵢ) cosφ − Im(Fᵢ) sinφ')
  expect(screen.getByRole('tooltip')).toHaveTextContent('φ = 2πft')
})
