import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { RuntimeConsoleSummary, RuntimeConsoleView } from './RuntimeConsoleView'
import { createRuntimeConsoleStore } from './store'

it('shows the latest message and updates its progress immediately', () => {
  const store = createRuntimeConsoleStore({ createId: () => 'event', now: () => 1 })
  render(<RuntimeConsoleSummary store={store} />)

  expect(screen.getByText('Runtime 이벤트가 없습니다.')).toBeInTheDocument()

  act(() => {
    store.append({ id: 'job', source: 'cae', level: 'info', phase: 'solve', message: '해석 중', progress: 0.456 })
  })

  expect(screen.getByText('CAE')).toBeInTheDocument()
  expect(screen.getByText('[solve]')).toBeInTheDocument()
  expect(screen.getByText('해석 중')).toBeInTheDocument()
  expect(screen.getByText('46%')).toBeInTheDocument()
  expect(screen.getByRole('progressbar', { name: '해석 중 진행률' })).toHaveAttribute('value', '0.456')

  act(() => {
    store.append({ id: 'job', source: 'cae', level: 'info', phase: 'solve', message: '해석 완료', progress: 1 })
  })

  expect(screen.getByText('해석 완료')).toBeInTheDocument()
  expect(screen.getByText('100%')).toBeInTheDocument()
})

it('keeps CAD routine messages out of the summary and expands error details in compact rows', () => {
  const store = createRuntimeConsoleStore()
  store.append({
    source: 'cad',
    level: 'error',
    message: '잘못된 재료입니다.',
    details: { file: 'material.ts', line: 3, stack: 'Error\n  at material.ts:3' },
  })
  store.append({ source: 'cad', level: 'info', message: '렌더링 완료' })
  const { unmount } = render(<RuntimeConsoleSummary store={store} />)
  expect(screen.getByText('잘못된 재료입니다.')).toBeInTheDocument()
  expect(screen.queryByText('렌더링 완료')).not.toBeInTheDocument()
  unmount()
  render(<RuntimeConsoleView store={store} />)
  expect(screen.queryByText('material.ts')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '잘못된 재료입니다. 이벤트 펼치기' }))
  expect(screen.getByText('material.ts')).toBeInTheDocument()
  expect(screen.getByRole('listitem')).toHaveClass('py-0.5')
  expect(screen.getByRole('list')).not.toHaveClass('divide-y')
  fireEvent.change(screen.getByLabelText('Runtime Console 검색'), { target: { value: 'material.ts' } })
  expect(screen.getByRole('listitem')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Level 필터'), { target: { value: 'warning' } })
  expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Runtime Console 지우기' }))
  expect(store.getSnapshot().events).toHaveLength(0)
})
