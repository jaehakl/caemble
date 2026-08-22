// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeConsoleView } from './RuntimeConsoleView'
import { createRuntimeConsoleStore } from './store'

describe('RuntimeConsoleView', () => {
  const scrollIntoView = vi.fn()

  beforeEach(() => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
  })

  afterEach(() => {
    cleanup()
    scrollIntoView.mockReset()
  })

  it('filters events, shows safe details, and clears the store', async () => {
    const user = userEvent.setup()
    const store = createRuntimeConsoleStore()
    store.append({
      id: 'cad-1',
      timestamp: 0,
      source: 'cad',
      level: 'info',
      phase: 'evaluate.completed',
      message: 'CAD 평가 완료',
      details: { revision: 2 },
    })
    store.append({
      id: 'cae-1',
      timestamp: 1,
      source: 'cae',
      level: 'error',
      phase: 'run.failed',
      message: 'CAE 실행 실패',
      runId: 'run-1',
    })
    render(<RuntimeConsoleView store={store} />)

    expect(screen.getByRole('log')).toHaveTextContent('CAD 평가 완료')
    expect(screen.getByRole('log')).toHaveTextContent('revision=')
    await user.selectOptions(screen.getByLabelText('Source 필터'), 'cae')
    expect(screen.queryByText('CAD 평가 완료')).not.toBeInTheDocument()
    expect(screen.getByText('CAE 실행 실패')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Runtime Console 검색'), 'missing')
    expect(screen.getByText('필터와 일치하는 이벤트가 없습니다.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Runtime Console 지우기' }))
    expect(store.getSnapshot().events).toHaveLength(0)
    expect(screen.getByText('Runtime 이벤트가 없습니다.')).toBeInTheDocument()
  })

  it('auto-scrolls on new events until the preference is disabled', async () => {
    const user = userEvent.setup()
    const store = createRuntimeConsoleStore()
    render(<RuntimeConsoleView store={store} />)
    scrollIntoView.mockClear()

    act(() => store.append({ source: 'gpstation', level: 'info', message: 'Job created' }))
    expect(scrollIntoView).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('checkbox', { name: '자동 스크롤' }))
    scrollIntoView.mockClear()
    act(() => store.append({ source: 'cae', level: 'info', message: 'Run started' }))
    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})
