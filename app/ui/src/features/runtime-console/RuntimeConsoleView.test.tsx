// @vitest-environment jsdom

import { act, cleanup, render, screen, within } from '@testing-library/react'
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

  it('renders compact expandable rows, filters events, and clears the store', async () => {
    const user = userEvent.setup()
    const store = createRuntimeConsoleStore()
    store.append({
      id: 'cad-1',
      timestamp: 0,
      source: 'cad',
      level: 'info',
      phase: 'evaluate.completed',
      message: 'CAD 평가 완료',
      jobId: 'job-1',
      runId: 'run-1',
      progress: 0.5,
      details: { revision: 2, taskCount: 1, sourceHash: '5886228f12a6931d9d7ca3fab3a3027d6' },
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

    const log = screen.getByRole('log')
    expect(log).toHaveTextContent('CAD 평가 완료')
    expect(log).not.toHaveTextContent('revision=')
    expect(log).not.toHaveTextContent('taskCount=')
    expect(log).not.toHaveTextContent('sourceHash=')
    expect(log).not.toHaveTextContent('job=job-1')
    expect(log).not.toHaveTextContent('run=run-1')
    expect(log.querySelector('time')).toBeNull()
    expect(within(log).queryByText('info')).not.toBeInTheDocument()
    expect(within(log).queryByText('error')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Level 필터')).toBeInTheDocument()
    expect(within(log).getByText('CAD')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()

    const toggle = screen.getByRole('button', { name: 'CAD 평가 완료 이벤트 펼치기' })
    const content = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
    const message = content?.querySelector('p')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(message).toHaveClass('truncate', 'whitespace-nowrap')
    await user.click(content!)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(screen.getByRole('button', { name: 'CAD 평가 완료 이벤트 접기' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'CAE 실행 실패 이벤트 펼치기' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(message).toHaveClass('whitespace-pre-wrap', 'break-words')
    expect(message).not.toHaveClass('truncate')

    await user.selectOptions(screen.getByLabelText('Source 필터'), 'cae')
    expect(screen.queryByText('CAD 평가 완료')).not.toBeInTheDocument()
    expect(screen.getByText('CAE 실행 실패')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Runtime Console 검색'), 'missing')
    expect(screen.getByText('필터와 일치하는 이벤트가 없습니다.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Runtime Console 지우기' }))
    expect(store.getSnapshot().events).toHaveLength(0)
    expect(screen.getByText('Runtime 이벤트가 없습니다.')).toBeInTheDocument()
  })

  it('updates one progress row per Run and Task while preserving its expanded state', async () => {
    const user = userEvent.setup()
    const store = createRuntimeConsoleStore()
    render(<RuntimeConsoleView store={store} />)

    act(() =>
      store.append({
        id: 'cae-progress:run-1:electric',
        source: 'cae',
        level: 'info',
        phase: 'run.progress',
        message: 'electric: solve',
        runId: 'run-1',
        progress: 0.25,
      }),
    )
    await user.click(screen.getByRole('button', { name: 'electric: solve 이벤트 펼치기' }))

    act(() => {
      store.append({
        id: 'cae-progress:run-1:electric',
        source: 'cae',
        level: 'info',
        phase: 'run.progress',
        message: 'electric: output',
        runId: 'run-1',
        progress: 0.75,
      })
      store.append({
        id: 'cae-progress:run-1:thermal',
        source: 'cae',
        level: 'info',
        phase: 'run.progress',
        message: 'thermal: solve',
        runId: 'run-1',
        progress: 0.5,
      })
      store.append({
        id: 'cae-progress:run-2:electric',
        source: 'cae',
        level: 'info',
        phase: 'run.progress',
        message: 'electric: solve',
        runId: 'run-2',
        progress: 0.1,
      })
    })

    expect(store.getSnapshot().events).toHaveLength(3)
    expect(screen.getAllByRole('progressbar')).toHaveLength(3)
    expect(screen.queryByText('25%')).not.toBeInTheDocument()
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()
    expect(screen.getByText('10%')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'electric: output 이벤트 접기' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
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
