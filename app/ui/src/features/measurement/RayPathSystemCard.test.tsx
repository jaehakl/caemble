import { render, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { RayPathSystemCard } from './RayPathSystemCard'
import { ExperimentRecordCatalog } from '../calculation/ExperimentRecordCatalog'

it('shows diffraction alongside existing reflection and detector event codes', () => {
  render(
    <ExperimentRecordCatalog
      analysisError={null}
      experimentId={1}
      insertDisabledReason={null}
      items={[]}
      loading={false}
      loadError={false}
      onInsert={() => undefined}
      systemResult={
        <RayPathSystemCard
          declared
          bundles={[
            {
              id: 'rayPaths',
              pathCount: 1,
              segmentCount: 3,
              vertices: new Float32Array(12),
              pathOffsets: new Uint32Array([0, 4]),
              segmentPower: new Float32Array([1, 0.7, 0.6]),
              pathWavelength: new Float32Array([550e-9]),
              segmentEvent: new Uint8Array([0, 11, 5]),
            },
          ]}
        />
      }
    />,
  )
  const events = within(screen.getByLabelText('Ray path events'))
  expect(events.getByText('reflection · 1')).toBeInTheDocument()
  expect(events.getByText('diffraction · 1')).toBeInTheDocument()
  expect(events.getByText('detector · 1')).toBeInTheDocument()
})
