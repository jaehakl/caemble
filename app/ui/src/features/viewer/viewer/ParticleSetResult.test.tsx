import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { ParticleSetResult } from './ParticleSetResult'
import type { RecordedParticleSet } from './particleSets'

const particles: RecordedParticleSet = {
  label: 'particles',
  identity: 'ids',
  lengthUnit: 'm',
  particleIds: [90, 2],
  materialIndices: new Int32Array([1, 0]),
  materialNames: ['Fluid', 'Steel'],
  times: new Float64Array([0, 1]),
  positions: new Float64Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]),
  attributes: {
    velocity: {
      quantityKind: 'kinematics.Velocity',
      unit: 'm.s-1',
      components: ['x', 'y', 'z'],
      values: new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    },
  },
}

it('selects recorded time, physical quantity and component while retaining identity/material display', () => {
  render(
    <ParticleSetResult
      particles={particles}
      renderViewer={(data) => <output data-testid="particles" data-position={data.geometries[0].positions[0]} />}
    />,
  )
  expect(screen.getByText(/ID 90 · Material Steel/)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Particle 물리량'), { target: { value: 'velocity' } })
  fireEvent.change(screen.getByLabelText('Particle 성분'), { target: { value: '2' } })
  expect(screen.getByText('kinematics.Velocity · m.s-1')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Transient playback' }))
  fireEvent.click(screen.getByRole('button', { name: '다음 프레임' }))
  expect(screen.getByTestId('particles')).toHaveAttribute('data-position', '2')
  fireEvent.change(screen.getByRole('combobox', { name: 'Particle ID' }), { target: { value: '2' } })
  expect(screen.getByText(/ID 2 · Material Fluid/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '점 크기' }))
  expect(screen.getByLabelText('Particle 점 크기')).toBeTruthy()
})

it('keeps physical DEM radius separate from the continuum point size control', () => {
  render(
    <ParticleSetResult
      particles={{
        ...particles,
        radius: 'radius',
        attributes: {
          ...particles.attributes,
          radius: { quantityKind: 'Length', unit: 'm', components: [], values: new Float64Array([0.1, 0.2, 0.1, 0.2]) },
        },
      }}
      renderViewer={() => <div />}
    />,
  )
  expect(screen.queryByLabelText('Particle 점 크기')).toBeNull()
  expect(screen.getByText(/실제 반경/)).toBeTruthy()
})
