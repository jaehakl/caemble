import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { MeshTransformResult } from './MeshTransformResult'
import type { RecordedMeshTransform } from './meshTransforms'
import type { MeshRenderData } from './meshFields'

const motion: RecordedMeshTransform = {
  label: 'motion',
  identity: 'body-mesh',
  bodyIds: ['body-90'],
  lengthUnit: 'm',
  times: new Float64Array([0, 1]),
  vertices: new Float64Array([0, 0, 0, 1, 0, 0, 0, 2, 0]),
  triangles: new Uint32Array([0, 1, 2]),
  vertexOffsets: new Uint32Array([0, 3]),
  triangleOffsets: new Uint32Array([0, 1]),
  localCenters: new Float64Array([0, 0, 0]),
  positions: new Float64Array([0, 0, 0, 2, 0, 0]),
  orientations: new Float64Array([1, 0, 0, 0, 0, 0, 0, 1]),
}

function renderViewer(data: MeshRenderData) {
  return <output data-testid="pose" data-vertices={JSON.stringify(Array.from(data.geometries[0].positions))} />
}

it('seeks to continuous physical time with rigid interpolation and no deformation multiplier controls', () => {
  render(<MeshTransformResult motion={motion} renderViewer={renderViewer} />)
  fireEvent.click(screen.getByRole('button', { name: 'Transient playback' }))
  fireEvent.change(screen.getByLabelText('Animation time'), { target: { value: '0.5' } })
  expect(screen.getByLabelText('Animation time')).toHaveValue('0.5')
  const vertices = JSON.parse(screen.getByTestId('pose').getAttribute('data-vertices')!)
  expect(vertices[0]).toBe(1)
  expect(vertices[3]).toBeCloseTo(1)
  expect(vertices[4]).toBeCloseTo(1)
  expect(screen.getByText(/실제 크기 1×/)).toBeTruthy()
  expect(screen.queryByText('자동 확대')).toBeNull()
  expect(screen.queryByLabelText(/displacement scale/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '다음 프레임' }))
  expect(screen.getByLabelText('Animation time')).toHaveValue('1')
  fireEvent.click(screen.getByRole('button', { name: '이전 프레임' }))
  expect(screen.getByLabelText('Animation time')).toHaveValue('0')
})

it('keeps a single snapshot visible with playback disabled', () => {
  render(
    <MeshTransformResult
      motion={{
        ...motion,
        times: new Float64Array([0]),
        positions: motion.positions.slice(0, 3),
        orientations: motion.orientations.slice(0, 4),
      }}
      renderViewer={renderViewer}
    />,
  )
  expect(screen.getByTestId('pose')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Transient playback' }))
  expect(screen.getByLabelText('Animation time')).toBeDisabled()
  expect(screen.getByRole('button', { name: '재생' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '이전 프레임' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '다음 프레임' })).toBeDisabled()
})
