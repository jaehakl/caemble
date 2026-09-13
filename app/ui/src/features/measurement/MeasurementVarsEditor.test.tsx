import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MeasurementVarsEditor, editTensorValues } from './MeasurementVarsEditor'
import type { Vars } from '@/lib/cad/model/types'

function Editor() {
  const [vars, setVars] = useState<Vars>({
    scalar: 0.5,
    line: [0.1, 0.2, 0.3],
    matrix: [
      [0.1, 0.2],
      [0.3, 0.4],
    ],
    volume: [[[0.1, 0.2]], [[0.3, 0.4]]],
    empty: [],
  })
  const [key, setKey] = useState<string | null>(null)
  const [valid, setValid] = useState(true)
  return (
    <>
      <MeasurementVarsEditor
        schema={{
          scalar: { shape: [], min: 0, max: 1 },
          line: { shape: [3], min: 0, max: 1 },
          matrix: { shape: [2, 2], min: 0, max: 1 },
          volume: { shape: [2, 1, 2], min: 0, max: 1 },
          empty: { shape: [0], min: 0, max: 1 },
        }}
        vars={vars}
        selectedKey={key}
        onSelectedKeyChange={setKey}
        onVarsChange={setVars}
        onValidityChange={setValid}
      />
      <output aria-label="vars">{JSON.stringify(vars)}</output>
      <button disabled={!valid}>Run</button>
    </>
  )
}

describe('Measurement Vars editor', () => {
  it('commits scalar inputs, synchronizes slider, and rejects invalid edits before switching', () => {
    render(<Editor />)
    fireEvent.change(screen.getByLabelText('scalar'), { target: { value: '0.75' } })
    expect(screen.getByText('Run')).toBeDisabled()
    fireEvent.keyDown(screen.getByLabelText('scalar'), { key: 'Enter' })
    expect(screen.getByLabelText('scalar 슬라이더')).toHaveValue('750')
    expect(screen.getByText('Run')).not.toBeDisabled()
    fireEvent.change(screen.getByLabelText('scalar'), { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Var line' }))
    expect(screen.getByRole('alert')).toHaveTextContent('유한한 숫자')
    expect(screen.getByLabelText('scalar')).toHaveValue('9')
    fireEvent.keyDown(screen.getByLabelText('scalar'), { key: 'Escape' })
    expect(screen.getByLabelText('scalar')).toHaveValue('0.75')
  })
  it('edits a selected matrix rectangle atomically and shuffles only that tensor', () => {
    render(<Editor />)
    fireEvent.click(screen.getByRole('button', { name: 'Var matrix' }))
    fireEvent.pointerDown(screen.getByLabelText('matrix[0,0] 선택'), { button: 0 })
    fireEvent.keyDown(screen.getByLabelText('matrix[1,1] 선택'), { key: 'Enter', shiftKey: true })
    fireEvent.change(screen.getByLabelText('일괄 편집 대상'), { target: { value: 'selected' } })
    fireEvent.change(screen.getByLabelText('일괄 편집 값'), { target: { value: '0.8' } })
    fireEvent.click(screen.getByRole('button', { name: '적용 4개' }))
    expect(screen.getByLabelText('matrix[1,1]')).toHaveValue('0.8')
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.6)
    fireEvent.click(screen.getByRole('button', { name: 'Shuffle · 전체' }))
    expect(JSON.parse(screen.getByLabelText('vars').textContent!).matrix).toEqual([
      [0.6, 0.6],
      [0.6, 0.6],
    ])
    expect(JSON.parse(screen.getByLabelText('vars').textContent!).line).toEqual([0.1, 0.2, 0.3])
    random.mockRestore()
  })
  it('edits higher rank slices and handles empty tensors', () => {
    render(<Editor />)
    fireEvent.click(screen.getByRole('button', { name: 'Var volume' }))
    fireEvent.change(screen.getByLabelText('volume 축 0 단면'), { target: { value: '1' } })
    expect(screen.getByLabelText('volume[1,0,1]')).toHaveValue('0.4')
    fireEvent.change(screen.getByLabelText('volume[1,0,1]'), { target: { value: '0.9' } })
    fireEvent.blur(screen.getByLabelText('volume[1,0,1]'))
    expect(JSON.parse(screen.getByLabelText('vars').textContent!).volume).toEqual([[[0.1, 0.2]], [[0.3, 0.9]]])
    fireEvent.click(screen.getByRole('button', { name: 'Var empty' }))
    expect(screen.getByText('원소가 없는 tensor입니다.')).toBeInTheDocument()
    expect(within(screen.getByLabelText('Measurement Vars 편집기')).queryByRole('slider')).not.toBeInTheDocument()
  })
  it('does not partially apply an overflowing bulk operation', () => {
    const original = [0.1, 0.8]
    expect(() => editTensorValues(original, [0, 1], 'add', 0.3, 0, 1)).toThrow('변경하지 않았습니다')
    expect(original).toEqual([0.1, 0.8])
    expect(editTensorValues(original, [0], 'multiply', 2, 0, 1)).toEqual([0.2, 0.8])
  })
})
