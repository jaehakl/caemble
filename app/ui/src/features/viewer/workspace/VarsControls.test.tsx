// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VarsControls } from './VarsControls'

afterEach(cleanup)

describe('VarsControls', () => {
  const schema = {
    width: { min: 1, max: 10 },
    offset: { min: [-5, -5], max: [5, 5] },
    fixed: { min: 3, max: 3 },
  } as const
  const variables = { width: 4, offset: [1, 2], fixed: 3 } as const

  it('renders scalar and tensor controls with their ranges and fixed state', () => {
    render(
      <VarsControls
        disabled={false}
        overridden={false}
        schema={schema}
        variables={variables}
        onChange={() => undefined}
        onReset={() => undefined}
      />,
    )

    expect(screen.getByRole('slider', { name: 'width 슬라이더' })).toHaveAttribute('min', '1')
    expect(screen.getByRole('spinbutton', { name: 'offset[1] 숫자 입력' })).toHaveValue(2)
    expect(screen.getByRole('spinbutton', { name: 'fixed 숫자 입력' })).toBeDisabled()
    expect(screen.getByText('고정값')).toBeInTheDocument()
  })

  it('updates one tensor leaf without changing the other vars', () => {
    const onChange = vi.fn()
    render(
      <VarsControls
        disabled={false}
        overridden
        schema={schema}
        variables={variables}
        onChange={onChange}
        onReset={() => undefined}
      />,
    )

    fireEvent.change(screen.getByRole('spinbutton', { name: 'offset[1] 숫자 입력' }), { target: { value: '4' } })

    expect(onChange).toHaveBeenCalledWith({ width: 4, offset: [1, 4], fixed: 3 })
  })

  it('keeps invalid numbers local and does not request evaluation', () => {
    const onChange = vi.fn()
    render(
      <VarsControls
        disabled={false}
        overridden
        schema={schema}
        variables={variables}
        onChange={onChange}
        onReset={() => undefined}
      />,
    )

    fireEvent.change(screen.getByRole('spinbutton', { name: 'width 숫자 입력' }), { target: { value: '20' } })

    expect(screen.getByRole('alert')).toHaveTextContent('1 이상 10 이하로 입력하세요.')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('offers reset only while overrides are active', () => {
    const onReset = vi.fn()
    const { rerender } = render(
      <VarsControls
        disabled={false}
        overridden={false}
        schema={schema}
        variables={variables}
        onChange={() => undefined}
        onReset={onReset}
      />,
    )

    expect(screen.getByRole('button', { name: '자동값 복원' })).toBeDisabled()
    rerender(
      <VarsControls
        disabled={false}
        overridden
        schema={schema}
        variables={variables}
        onChange={() => undefined}
        onReset={onReset}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '자동값 복원' }))
    expect(onReset).toHaveBeenCalledOnce()
  })

  it('keeps controls enabled without a transient Viewer update banner', () => {
    render(
      <VarsControls
        disabled={false}
        overridden
        schema={schema}
        variables={variables}
        onChange={() => undefined}
        onReset={() => undefined}
      />,
    )

    expect(screen.queryByText(/Viewer 업데이트 중입니다/)).not.toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'width 슬라이더' })).toBeEnabled()
    expect(screen.getByRole('spinbutton', { name: 'width 숫자 입력' })).toBeEnabled()
  })
})
