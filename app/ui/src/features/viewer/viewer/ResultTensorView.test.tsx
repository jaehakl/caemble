import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { RecordedResultContract } from '@/contracts/results'
import type { RecordedDataRule } from '@/lib/cad/model'
import { ResultTensorView } from './ResultTensorView'

vi.mock('./RecordedDataResults', () => ({
  default: ({ recordedData }: { recordedData: unknown }) => (
    <output data-testid="slice">{JSON.stringify(recordedData)}</output>
  ),
}))

it('slices spatial axes and indexes time and component using the frozen contract without Catalog access', () => {
  const contract: RecordedResultContract = {
    task: 'any',
    output: 'field',
    solver: { name: 'fixture', version: '1' },
    artifactType: 'fixture',
    catalogRevision: 'old',
    schema: {},
    visualization: { kind: 'structured-field', spatialAxes: [1, 2, 3] },
  }
  const rule: RecordedDataRule = {
    label: 'arbitrary',
    methodId: 'fixture',
    parameters: {},
    target: [],
    result: {
      dtype: 'float64',
      quantityKind: 'Dimensionless',
      unit: '1',
      axes: [{ name: 'time' }, { name: 'x' }, { name: 'y' }, { name: 'z' }, { name: 'component' }],
    },
  }
  render(
    <ResultTensorView
      name="arbitrary"
      contract={contract}
      rules={[rule]}
      data={{
        arbitrary: {
          shape: [2, 2, 2, 2, 3],
          axes: [{ ticks: [0, 1] }, { ticks: [0, 1] }, { ticks: [0, 1] }, { ticks: [0, 1] }, { ticks: [0, 1, 2] }],
          storage: {
            kind: 'inline',
            value: Array.from({ length: 2 }, (_, t) =>
              Array.from({ length: 2 }, (_, x) =>
                Array.from({ length: 2 }, (_, y) =>
                  Array.from({ length: 2 }, (_, z) =>
                    Array.from({ length: 3 }, (_, c) => t * 24 + x * 12 + y * 6 + z * 3 + c),
                  ),
                ),
              ),
            ),
          },
        },
      }}
    />,
  )
  const slice = () => JSON.parse(screen.getByTestId('slice').textContent!).arbitrary
  expect(slice().shape).toEqual([2, 2])
  expect(slice().storage.value).toEqual([
    [0, 3],
    [6, 9],
  ])
  fireEvent.change(screen.getByLabelText('축 0 index'), { target: { value: '1' } })
  fireEvent.change(screen.getByLabelText('축 1 index'), { target: { value: '1' } })
  fireEvent.change(screen.getByLabelText('축 4 index'), { target: { value: '2' } })
  expect(slice().storage.value).toEqual([
    [38, 41],
    [44, 47],
  ])
  fireEvent.click(screen.getByLabelText('표시 축 2'))
  expect(slice().shape).toEqual([2])
  expect(slice().storage.value).toEqual([38, 41])
})
