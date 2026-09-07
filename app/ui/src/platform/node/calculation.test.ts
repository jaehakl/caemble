// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { compileNodeCalculation, runNodeCalculation } from './calculation'

describe('Node Calculation adapter', () => {
  it('retains a real source range for a TypeScript diagnostic', async () => {
    await expect(
      compileNodeCalculation(
        'export default function calculate(record) {\n const value = "text";\n return { dtype: "float64", data: value.toFixed(2) }\n}',
      ),
    ).rejects.toMatchObject({
      code: 'compile',
      diagnostic: { range: { startLineNumber: 3 }, sourceLine: expect.stringContaining('toFixed') },
    })
  })

  it('preserves parser coordinates and a resolvable reference without inventing a span', async () => {
    await expect(
      compileNodeCalculation('export default function calculate(record) {\n return {\n}'),
    ).rejects.toMatchObject({
      stage: 'compile',
      language: 'javascript',
      sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      referenceId: 'diagnostic.calculation',
      diagnostics: [
        expect.objectContaining({
          file: 'calculation.js',
          range: expect.objectContaining({ startLineNumber: 3 }),
          location: expect.objectContaining({ file: 'calculation.js', line: 3 }),
        }),
      ],
    })
  })

  it('retains bounded logs before a runtime failure with source identity', async () => {
    await expect(
      runNodeCalculation(
        'export default function calculate(record) { console.log("before failure"); throw new Error("failed"); }',
        {},
      ),
    ).rejects.toMatchObject({
      code: 'runtime',
      stage: 'execution',
      language: 'javascript',
      sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      logs: ['before failure'],
      referenceId: 'diagnostic.calculation',
      diagnostics: [expect.objectContaining({ location: null })],
    })
  })

  it('guards computed array indexes using the same source diagnostic as the browser', async () => {
    await expect(
      runNodeCalculation(
        'export default function calculate(record) { const values = [1, 2]; const index = -1; return { dtype: "float64", data: values[index] } }',
        {},
      ),
    ).rejects.toMatchObject({ code: 'policy', diagnostic: { sourceLine: expect.stringContaining('values[index]') } })
  })

  it('keeps logs bounded while preserving a normalized result', async () => {
    const result = await runNodeCalculation(
      'export default function calculate(record) { for (let i = 0; i < 150; i++) console.log(i); return { dtype: "float64", data: 7 } }',
      {},
    )
    expect(result.output).toEqual({ dtype: 'float64', shape: [], data: 7, axes: [] })
    expect(result.logs.length).toBeLessThanOrEqual(101)
    expect(result.logs[result.logs.length - 1]).toMatch(/truncat/i)
  })
})
