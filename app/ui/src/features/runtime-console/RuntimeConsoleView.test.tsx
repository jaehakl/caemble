import { act, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { RuntimeConsoleSummary } from './RuntimeConsoleView'
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
