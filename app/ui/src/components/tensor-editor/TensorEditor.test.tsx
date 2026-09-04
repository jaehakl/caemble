import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TensorEditor } from './TensorEditor'

class ResizeObserverStub {
  disconnect() {}
  observe() {}
  unobserve() {}
}

describe('TensorEditor brush strength', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('recomputes strength on an external reset and preserves manual input between resets', () => {
    const onValueChange = vi.fn()
    const initialProps = {
      axes: [
        { name: 'row', ticks: [0, 1] },
        { name: 'column', ticks: [0, 1] },
      ],
      comparison: {
        primaryColor: '#f97316',
        primaryLabel: 'Target',
        series: [],
      },
      constraintMaximum: 1_000,
      constraintMinimum: -1_000,
      displayDomainResetKey: 'prediction:0',
      label: 'Prediction output',
      maximum: 0.5,
      minimum: -0.5,
      selectionResetKey: 'prediction:0',
      shape: [2, 2],
      value: [
        [0, 0],
        [0, 0],
      ],
      onValueChange,
    } as const
    const { rerender } = render(<TensorEditor {...initialProps} />)
    const strength = screen.getByLabelText<HTMLInputElement>('Strength')

    expect(strength.value).toBe('0.05')

    rerender(
      <TensorEditor
        {...initialProps}
        displayDomainResetKey="prediction:1"
        maximum={110}
        minimum={90}
        selectionResetKey="prediction:1"
        value={[
          [90, 100],
          [100, 110],
        ]}
      />,
    )
    expect(strength.value).toBe('1')

    fireEvent.change(strength, { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Prediction output display range 맞춤' }))
    expect(strength.value).toBe('7')

    const canvas = screen.getByLabelText<HTMLCanvasElement>('Prediction output heatmap slice 0')
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      bottom: 100,
      height: 100,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    Object.defineProperties(canvas, {
      hasPointerCapture: { value: () => true },
      releasePointerCapture: { value: vi.fn() },
      setPointerCapture: { value: vi.fn() },
    })
    fireEvent.pointerDown(canvas, { clientX: 25, clientY: 25, pointerId: 1 })
    fireEvent.pointerUp(canvas, { clientX: 25, clientY: 25, pointerId: 1 })
    expect(onValueChange).toHaveBeenCalledTimes(1)

    rerender(
      <TensorEditor
        {...initialProps}
        displayDomainResetKey="prediction:1"
        maximum={120}
        minimum={80}
        selectionResetKey="prediction:1"
        value={onValueChange.mock.calls[0][0]}
      />,
    )
    expect(strength.value).toBe('7')

    rerender(
      <TensorEditor
        {...initialProps}
        displayDomainResetKey="prediction:2"
        maximum={120}
        minimum={80}
        selectionResetKey="prediction:2"
        value={[
          [90, 100],
          [100, 110],
        ]}
      />,
    )
    expect(strength.value).toBe('2')
    expect(onValueChange).toHaveBeenCalledTimes(1)
  })
})
