import { describe, expect, it } from 'vitest'
import { describeCaeProgress } from './progress'

describe('physical CAE progress', () => {
  it('keeps accepted time visible when nested iteration counters restart or retry', () => {
    for (const stage of ['flow-pressure-iteration', 'flow-nonlinear-iteration', 'flow-retry']) {
      const description = describeCaeProgress({
        task: 'flow',
        stage,
        completed: 0,
        total: 1000,
        time: 0.32,
        physicalTime: { completed: 0.3, total: 6, dt: 0.02 },
      })
      expect(description?.fraction).toBeCloseTo(0.05)
      expect(description?.message).toContain('시간 0.3/6 s')
      expect(description?.message).toContain('Δt 0.02 s')
      expect(description?.message).toContain(stage)
    }
  })

  it('retains generic progress for other solvers and malformed optional time', () => {
    for (const physicalTime of [undefined, null, {}, { completed: NaN, total: 6, dt: 0.02 }]) {
      expect(describeCaeProgress({ task: 'solve', stage: 'iteration', completed: 3, total: 10, physicalTime })).toEqual(
        { message: 'solve · iteration · 3/10', fraction: 0.3 },
      )
    }
  })

  it('shows small timesteps without rounding them to zero and preserves retry reasons', () => {
    const description = describeCaeProgress({
      task: 'flow',
      stage: 'flow-retry',
      message: 'Courant exceeded',
      physicalTime: { completed: 2, total: 6, dt: 0.000000125 },
    })
    expect(description?.message).toContain('Courant exceeded')
    expect(description?.message).toContain('Δt 1.25e-7 s')
    expect(description?.fraction).toBeCloseTo(1 / 3)
  })
})
