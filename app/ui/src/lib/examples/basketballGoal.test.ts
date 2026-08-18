import { measurements } from '@jscad/modeling'
import { transform } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { executeCompiledCode } from '../cad/execution/userModule'
import { createSolidPointTester } from '../cad/geometry/solid'
import { defineTask } from '../cad/model/v5'
import { analyzeCadSource } from '../cad/source/sourceAnalysis'
import { basketballGoalCode } from './basketballGoal'

describe('Basketball Goal CAD API v7 example', () => {
  it('passes source policy, compiles, evaluates stable IDs, and creates an annular rim', async () => {
    analyzeCadSource(basketballGoalCode)
    const compiled = await transform(basketballGoalCode, {
      format: 'cjs',
      jsxFactory: 'h',
      jsxFragment: 'Fragment',
      loader: 'tsx',
      platform: 'browser',
      target: 'es2020',
    })
    const result = executeCompiledCode(
      compiled.code,
      '7'.repeat(64),
      {},
      'async def simulate(*, sim, tasks, vars):\n    return None\n',
      {
        preview: defineTask({
          kernel: { name: 'basketball-goal-preview', version: '1.0.0' },
          config: () => ({}),
        }),
      },
    )

    expect(result.scene.parts.map(({ id }) => id)).toEqual(['goal.pole', 'goal.arm', 'goal.backboard', 'goal.rim'])

    const arm = result.scene.parts.find(({ id }) => id === 'goal.arm')!
    const armBounds = measurements.measureBoundingBox(arm.geometry)
    expect(armBounds[0][1]).toBeCloseTo(0, 6)
    expect(armBounds[1][1]).toBeCloseTo(200, 6)

    const rim = result.scene.parts.find(({ id }) => id === 'goal.rim')!
    const rimSolid = createSolidPointTester(rim.geometry)
    if (!rimSolid) throw new Error('Basketball rim must evaluate to a closed solid.')
    expect(rimSolid.contains([0, 155, 280])).toBe(false)
    expect(rimSolid.contains([20.5, 155, 280])).toBe(true)
  })
})
