import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Vars } from '@/lib/cad/model'
import { VarsEditor } from './VarsEditor'

const schema = {
  length: { shape: [], min: -10, max: 10 },
  tensor: { shape: [2], min: 0, max: 100 },
  ratio: { shape: [], min: 0, max: 1 },
  fixed: { shape: [], min: 5, max: 5 },
  height: { shape: [], min: 100, max: 200 },
}
const value = { length: 0, tensor: [20, 40], ratio: 0, fixed: 5, height: 100 }

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      pointerId: number
      constructor(type: string, init: PointerEventInit) {
        super(type, init)
        this.pointerId = init.pointerId ?? 1
      }
    },
  )
  const captured = new WeakMap<HTMLElement, number>()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const key = this.dataset.scalarKey
    const top = key ? Object.keys(schema).indexOf(key) * 50 : 0
    return { left: 0, top, right: 100, bottom: top + 20, width: 100, height: 20, x: 0, y: top, toJSON() {} }
  })
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: {
      configurable: true,
      value(this: HTMLElement, id: number) {
        captured.set(this, id)
      },
    },
    hasPointerCapture: {
      configurable: true,
      value(this: HTMLElement, id: number) {
        return captured.get(this) === id
      },
    },
    releasePointerCapture: {
      configurable: true,
      value(this: HTMLElement) {
        captured.delete(this)
      },
    },
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('previews a fast cross-row stroke and commits all scalars once, skipping tensor and fixed rows', () => {
  const changed = vi.fn()
  render(<VarsEditor schema={schema} value={value} onValueChange={changed} />)
  const first = screen.getByRole('slider', { name: 'length' })
  fireEvent.pointerDown(first, { button: 0, pointerId: 1, clientX: 75, clientY: 10 })
  fireEvent.pointerMove(first, { pointerId: 1, clientX: 75, clientY: 210 })
  expect(changed).not.toHaveBeenCalled()
  expect(screen.getByRole('slider', { name: 'ratio' })).toHaveAttribute('aria-valuenow', '0.75')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  fireEvent.pointerUp(first, { pointerId: 1, clientX: 75, clientY: 210 })
  expect(changed).toHaveBeenCalledExactlyOnceWith({ length: 5, tensor: [20, 40], ratio: 0.75, fixed: 5, height: 175 })
})

it('clamps outside the horizontal bounds and rolls back cancelled gestures', () => {
  const changed = vi.fn()
  render(<VarsEditor schema={schema} value={value} onValueChange={changed} />)
  const bar = screen.getByRole('slider', { name: 'length' })
  fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientX: 200, clientY: 10 })
  expect(bar).toHaveAttribute('aria-valuenow', '10')
  fireEvent.pointerCancel(bar, { pointerId: 1 })
  expect(bar).toHaveAttribute('aria-valuenow', '0')
  expect(changed).not.toHaveBeenCalled()
  fireEvent.pointerDown(bar, { button: 0, pointerId: 2, clientX: -50, clientY: 10 })
  fireEvent.pointerUp(bar, { pointerId: 2, clientX: -50, clientY: 10 })
  expect(changed).toHaveBeenCalledExactlyOnceWith({ ...value, length: -10 })
})

it('supports keyboard limits and fractional steps while disabling fixed or unavailable vars', () => {
  const changed = vi.fn()
  const { rerender } = render(<VarsEditor schema={schema} value={value} onValueChange={changed} />)
  const bar = screen.getByRole('slider', { name: 'ratio' })
  fireEvent.keyDown(bar, { key: 'ArrowRight' })
  expect(changed).toHaveBeenLastCalledWith({ ...value, ratio: 0.01 })
  fireEvent.keyDown(bar, { key: 'End' })
  expect(changed).toHaveBeenLastCalledWith({ ...value, ratio: 1 })
  fireEvent.keyDown(screen.getByRole('slider', { name: 'length' }), { key: 'Home' })
  expect(changed).toHaveBeenLastCalledWith({ ...value, length: -10, ratio: 1 })
  fireEvent.keyDown(screen.getByRole('slider', { name: 'fixed' }), { key: 'End' })
  expect(changed).toHaveBeenCalledTimes(3)
  rerender(<VarsEditor schema={schema} value={value} disabled onValueChange={changed} />)
  fireEvent.keyDown(screen.getByRole('slider', { name: 'ratio' }), { key: 'End' })
  expect(changed).toHaveBeenCalledTimes(3)
})

it('shows the tensor mean, commits bars on release, and collapses the editor on schema replacement', () => {
  const changed = vi.fn()
  const { rerender } = render(<VarsEditor schema={schema} value={value} resetKey="one" onValueChange={changed} />)
  expect(screen.getByLabelText('tensor 평균')).toHaveTextContent('30')
  fireEvent.click(screen.getByRole('button', { name: 'tensor tensor 편집' }))
  const bars = screen.getByLabelText('tensor one-dimensional bars')
  vi.spyOn(bars, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 170, height: 152 } as DOMRect)
  fireEvent.pointerDown(bars, { pointerId: 1, clientX: 75, clientY: 68 })
  expect(changed).not.toHaveBeenCalled()
  fireEvent.pointerUp(bars, { pointerId: 1, clientX: 75, clientY: 68 })
  expect(changed).toHaveBeenCalledExactlyOnceWith({ ...value, tensor: [50, 40] })
  rerender(
    <VarsEditor
      schema={{ ...schema, tensor: { ...schema.tensor, max: 200 } }}
      value={value}
      resetKey="one"
      onValueChange={changed}
    />,
  )
  expect(screen.queryByRole('region', { name: 'tensor tensor 상세 편집' })).not.toBeInTheDocument()
})

it('flushes pending selected-region wheel changes when collapsing the tensor', () => {
  vi.useFakeTimers()
  const changed = vi.fn()
  function Harness() {
    const [vars, setVars] = useState<Vars>({
      heat: [
        [0, 0],
        [0, 0],
      ],
    })
    return (
      <VarsEditor
        schema={{ heat: { shape: [2, 2], min: 0, max: 100 } }}
        value={vars}
        onValueChange={(next) => {
          changed(next)
          setVars(next)
        }}
      />
    )
  }
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'heat tensor 편집' }))
  act(() => vi.advanceTimersByTime(1))
  const heatmap = screen.getByLabelText('heat heatmap slice 0')
  vi.spyOn(heatmap, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 100 } as DOMRect)
  fireEvent.pointerDown(heatmap, { pointerId: 1, clientX: 10, clientY: 10 })
  fireEvent.pointerMove(heatmap, { pointerId: 1, clientX: 80, clientY: 10 })
  fireEvent.pointerUp(heatmap, { pointerId: 1 })
  fireEvent.wheel(heatmap, { deltaY: -1 })
  expect(changed).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'heat tensor 편집' }))
  expect(changed).toHaveBeenCalledExactlyOnceWith({
    heat: [
      [1, 1],
      [0, 0],
    ],
  })
  act(() => vi.advanceTimersByTime(300))
  expect(changed).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('region', { name: 'heat tensor 상세 편집' })).not.toBeInTheDocument()
  expect(screen.getByLabelText('heat 평균')).toHaveTextContent('0.5')
})

it('discards an in-flight stroke when the document changes and reports an empty schema', () => {
  const changed = vi.fn()
  const { rerender } = render(<VarsEditor schema={schema} value={value} resetKey="one" onValueChange={changed} />)
  const bar = screen.getByRole('slider', { name: 'length' })
  fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 90, clientY: 10 })
  rerender(<VarsEditor schema={schema} value={value} resetKey="two" onValueChange={changed} />)
  fireEvent.pointerUp(screen.getByRole('slider', { name: 'length' }), { pointerId: 1, clientX: 90, clientY: 10 })
  expect(changed).not.toHaveBeenCalled()
  rerender(<VarsEditor schema={{}} value={{}} onValueChange={changed} />)
  expect(screen.getByText('정의된 vars가 없습니다.')).toBeVisible()
})

it('expands tensors independently using Enter and Space without opening a dialog', async () => {
  const user = userEvent.setup()
  render(
    <VarsEditor
      schema={{ a: { shape: [2], min: 0, max: 10 }, b: { shape: [2], min: 0, max: 10 } }}
      value={{ a: [1, 2], b: [3, 4] }}
      onValueChange={vi.fn()}
    />,
  )
  const a = screen.getByRole('button', { name: 'a tensor 편집' })
  const b = screen.getByRole('button', { name: 'b tensor 편집' })
  expect(a).toHaveAttribute('aria-expanded', 'false')
  expect(b).toHaveAttribute('aria-expanded', 'false')
  a.focus()
  await user.keyboard('{Enter}')
  const firstEditor = screen.getByRole('region', { name: 'a tensor 상세 편집' })
  expect(a).toHaveAttribute('aria-controls', firstEditor.id)
  b.focus()
  await user.keyboard(' ')
  expect(a).toHaveAttribute('aria-expanded', 'true')
  expect(b).toHaveAttribute('aria-expanded', 'true')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await user.keyboard('{Enter}')
  expect(screen.queryByRole('region', { name: 'b tensor 상세 편집' })).not.toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'a tensor 상세 편집' })).toBe(firstEditor)
  expect(b).toHaveFocus()
})

it('merges concurrent delayed tensor edits with the latest scalar value and flushes numeric input on collapse', () => {
  vi.useFakeTimers()
  const changed = vi.fn()
  function Harness() {
    const [vars, setVars] = useState<Vars>({ first: [1], second: [2], ratio: 0 })
    return (
      <VarsEditor
        schema={{
          first: { shape: [1], min: 0, max: 10 },
          second: { shape: [1], min: 0, max: 10 },
          ratio: { shape: [], min: 0, max: 1 },
        }}
        value={vars}
        onValueChange={(next) => {
          changed(next)
          setVars(next)
        }}
      />
    )
  }
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'first tensor 편집' }))
  fireEvent.click(screen.getByRole('button', { name: 'second tensor 편집' }))
  const inputs = screen.getAllByRole('spinbutton')
  fireEvent.change(inputs[0], { target: { value: '6' } })
  fireEvent.change(inputs[1], { target: { value: '8' } })
  fireEvent.keyDown(screen.getByRole('slider', { name: 'ratio' }), { key: 'End' })
  expect(inputs[0]).toHaveValue(6)
  expect(inputs[1]).toHaveValue(8)
  fireEvent.click(screen.getByRole('button', { name: 'first tensor 편집' }))
  expect(changed).toHaveBeenLastCalledWith({ first: [6], second: [2], ratio: 1 })
  act(() => vi.advanceTimersByTime(350))
  expect(changed).toHaveBeenLastCalledWith({ first: [6], second: [8], ratio: 1 })
  expect(changed).toHaveBeenCalledTimes(3)
  fireEvent.click(screen.getByRole('button', { name: 'first tensor 편집' }))
  const reopenedInputs = screen.getAllByRole('spinbutton')
  fireEvent.change(reopenedInputs[0], { target: { value: '7' } })
  fireEvent.change(reopenedInputs[1], { target: { value: '9' } })
  act(() => vi.advanceTimersByTime(350))
  expect(changed).toHaveBeenLastCalledWith({ first: [7], second: [9], ratio: 1 })
  expect(changed).toHaveBeenCalledTimes(5)
})

it('keeps a scalar stroke active while another tensor commits a pending wheel change', () => {
  vi.useFakeTimers()
  const changed = vi.fn()
  function Harness() {
    const [vars, setVars] = useState<Vars>({ length: 0, heat: [[0]], height: 100 })
    return (
      <VarsEditor
        schema={{ length: schema.length, heat: { shape: [1, 1], min: 0, max: 100 }, height: schema.height }}
        value={vars}
        onValueChange={(next) => {
          changed(next)
          setVars(next)
        }}
      />
    )
  }
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'heat tensor 편집' }))
  const heatmap = screen.getByLabelText('heat heatmap slice 0')
  fireEvent.pointerDown(heatmap, { pointerId: 1, button: 0, clientX: 10, clientY: 10 })
  fireEvent.pointerUp(heatmap, { pointerId: 1 })
  fireEvent.wheel(heatmap, { deltaY: -1 })
  const first = screen.getByRole('slider', { name: 'length' })
  fireEvent.pointerDown(first, { pointerId: 2, button: 0, clientX: 75, clientY: 10 })
  act(() => vi.advanceTimersByTime(250))
  expect(changed).toHaveBeenCalledExactlyOnceWith({ length: 0, heat: [[1]], height: 100 })
  expect(first).toHaveAttribute('aria-valuenow', '5')
  fireEvent.pointerMove(first, { pointerId: 2, clientX: 75, clientY: 210 })
  fireEvent.pointerUp(first, { pointerId: 2, clientX: 75, clientY: 210 })
  expect(changed).toHaveBeenLastCalledWith({ length: 5, heat: [[1]], height: 175 })
  expect(screen.getByRole('button', { name: 'heat tensor 편집' })).toHaveAttribute('aria-expanded', 'true')
})

it('renders compact high-rank slices in pages of two', () => {
  render(
    <VarsEditor
      schema={{ volume: { shape: [3, 1, 1], min: 0, max: 10 } }}
      value={{ volume: [[[1]], [[2]], [[3]]] }}
      onValueChange={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'volume tensor 편집' }))
  expect(screen.getByLabelText('volume heatmap slice 0')).toBeVisible()
  expect(screen.getByLabelText('volume heatmap slice 1')).toBeVisible()
  expect(screen.queryByLabelText('volume heatmap slice 2')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '다음 slice 페이지' }))
  expect(screen.getByLabelText('volume heatmap slice 2')).toBeVisible()
})
