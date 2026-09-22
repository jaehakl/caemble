import { describe, expect, it } from 'vitest'
import { createRuntimeConsoleStore } from './store'

describe('Runtime Console store', () => {
  it('moves an updated progress event to the latest position and normalizes its progress', () => {
    const store = createRuntimeConsoleStore({ createId: () => 'generated', now: () => 1 })

    store.append({ id: 'job', source: 'cae', level: 'info', message: '시작', progress: -1 })
    store.append({ id: 'notice', source: 'calculation', level: 'warning', message: '다른 메시지' })
    const updated = store.append({ id: 'job', source: 'cae', level: 'info', message: '완료', progress: 2 })

    expect(store.getSnapshot().events.map((event) => event.id)).toEqual(['notice', 'job'])
    expect(store.getSnapshot().latestEvent).toBe(updated)
    expect(store.getSnapshot().latestEvent?.progress).toBe(1)
  })

  it('tracks zero and intermediate progress and clears the latest event', () => {
    const store = createRuntimeConsoleStore({ createId: () => 'generated', now: () => 1 })

    store.append({ id: 'job', source: 'cae', level: 'info', message: '대기', progress: 0 })
    expect(store.getSnapshot().latestEvent?.progress).toBe(0)

    store.append({ id: 'job', source: 'cae', level: 'info', message: '진행 중', progress: 0.456 })
    expect(store.getSnapshot().latestEvent?.progress).toBe(0.456)

    store.clear()
    expect(store.getSnapshot()).toEqual({ events: [], byteLength: 0, latestEvent: null })
  })
})

it.each([true, false])('merges preflight and streamed failures in either arrival order (%s)', (preflightFirst) => {
  const store = createRuntimeConsoleStore()
  const phases = preflightFirst ? ['preflight.failed', 'job.failed'] : ['job.failed', 'preflight.failed']
  for (const phase of phases)
    store.append({ source: 'cae', level: 'error', phase, message: '실행 실패', details: { batchId: 'one' } })
  expect(store.getSnapshot().events).toHaveLength(1)
  store.append({
    source: 'cae',
    level: 'error',
    phase: 'preflight.failed',
    message: '실행 실패',
    details: { batchId: 'two' },
  })
  expect(store.getSnapshot().events).toHaveLength(2)
  store.append({
    source: 'cae',
    level: 'error',
    phase: 'preflight.result.failed',
    message: '실행 실패',
    details: { batchId: 'one', result: 'field' },
  })
  expect(store.getSnapshot().events).toHaveLength(3)
})
