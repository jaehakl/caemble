import { describe, expect, it, vi } from 'vitest'
import { createRuntimeConsoleStore, RUNTIME_CONSOLE_MAX_BYTES, RUNTIME_CONSOLE_MAX_EVENTS } from './store'

describe('Runtime Console store', () => {
  it('completes and normalizes events while retaining only redacted scalar details', () => {
    const store = createRuntimeConsoleStore({ createId: () => 'generated-1', now: () => 1234 })

    const event = store.append({
      source: 'cae',
      level: 'warning',
      phase: 'progress',
      message: 'Solving',
      progress: 1.5,
      details: {
        task: 'thermal',
        attempt: 2,
        cached: false,
        optional: null,
        accessToken: 'secret-value',
        nested: { unsafe: true },
        invalidNumber: Number.POSITIVE_INFINITY,
      } as never,
    })

    expect(event).toEqual({
      id: 'generated-1',
      timestamp: 1234,
      source: 'cae',
      level: 'warning',
      phase: 'progress',
      message: 'Solving',
      progress: 1,
      details: {
        task: 'thermal',
        attempt: 2,
        cached: false,
        optional: null,
        accessToken: '[REDACTED]',
      },
    })
  })

  it('updates a progress event with the same explicit ID without adding another row', () => {
    const store = createRuntimeConsoleStore()
    const subscriber = vi.fn()
    store.subscribe(subscriber)

    store.append({
      id: 'cae-progress:run-1:electric',
      timestamp: 1,
      source: 'cae',
      level: 'info',
      phase: 'run.progress',
      message: 'electric: solve',
      runId: 'run-1',
      progress: 0.25,
      details: { task: 'electric', stage: 'solve', completed: 1, total: 4 },
    })
    const updated = store.append({
      id: 'cae-progress:run-1:electric',
      timestamp: 2,
      source: 'cae',
      level: 'info',
      phase: 'run.progress',
      message: 'electric: output',
      runId: 'run-1',
      progress: 0.75,
      details: { task: 'electric', stage: 'output', completed: 3, total: 4 },
    })

    expect(store.getSnapshot().events).toEqual([updated])
    expect(updated).toMatchObject({
      id: 'cae-progress:run-1:electric',
      timestamp: 2,
      message: 'electric: output',
      progress: 0.75,
      details: { task: 'electric', stage: 'output', completed: 3, total: 4 },
    })
    expect(store.getSnapshot().byteLength).toBe(new TextEncoder().encode(JSON.stringify(updated)).byteLength)
    expect(subscriber).toHaveBeenCalledTimes(2)
  })

  it('evicts the oldest events at both the 500 event and 256 KiB FIFO limits', () => {
    const store = createRuntimeConsoleStore()
    for (let index = 0; index <= RUNTIME_CONSOLE_MAX_EVENTS; index += 1) {
      store.append({ id: `count-${index}`, timestamp: index, source: 'cad', level: 'info', message: 'ready' })
    }
    expect(store.getSnapshot().events).toHaveLength(RUNTIME_CONSOLE_MAX_EVENTS)
    expect(store.getSnapshot().events[0]?.id).toBe('count-1')

    store.clear()
    for (let index = 0; index < 100; index += 1) {
      store.append({
        id: `bytes-${index}`,
        timestamp: index,
        source: 'gpstation',
        level: 'info',
        message: `${index}:${'한'.repeat(1800)}`,
      })
    }
    const snapshot = store.getSnapshot()
    expect(snapshot.byteLength).toBeLessThanOrEqual(RUNTIME_CONSOLE_MAX_BYTES)
    expect(snapshot.events.length).toBeLessThan(100)
    expect(snapshot.events[snapshot.events.length - 1]?.id).toBe('bytes-99')
    expect(snapshot.events[0]?.id).not.toBe('bytes-0')
  })

  it('notifies subscribers and clears only in-memory events', () => {
    const store = createRuntimeConsoleStore()
    const subscriber = vi.fn()
    const unsubscribe = store.subscribe(subscriber)

    store.append({ source: 'cad', level: 'info', message: 'Compiled' })
    store.clear()
    unsubscribe()
    store.append({ source: 'cae', level: 'error', message: 'Failed' })

    expect(subscriber).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().events).toHaveLength(1)
    expect(store.getSnapshot().events[0]?.message).toBe('Failed')
  })
})
