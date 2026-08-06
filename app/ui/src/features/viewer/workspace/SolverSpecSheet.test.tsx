import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { defineKernelTask, simulationProgramManifest } from '@/lib/cad/simulation'
import SolverSpecSheet from './SolverSpecSheet'

const simulationProgram = simulationProgramManifest(
  {
    electric: defineKernelTask({ name: 'dc-current-density', version: '0.0.0' }, {}),
  },
  {
    measuredCurrent: {
      dtype: 'float64',
      unit: 'A',
      quantityKind: 'electromagnetism.ElectricCurrent',
    },
  },
  'async def simulate(*, sim, tasks, vars, world):\n    return None\n',
)

describe('SolverSpecSheet', () => {
  it('renders the Experiment manifest and registered kernel descriptor without kernel-specific UI', () => {
    const markup = renderToStaticMarkup(
      <SolverSpecSheet compatibility={{ status: 'compatible', issues: [] }} simulationProgram={simulationProgram} />,
    )

    expect(markup).toContain('Simulation compatible')
    expect(markup).toContain('Experiment Program')
    expect(markup).toContain('electric')
    expect(markup).toContain('dc-current-density@0.0.0')
    expect(markup).toContain('Global RecordedData')
    expect(markup).toContain('measuredCurrent')
    expect(markup).toContain('relativeTolerance')
    expect(markup).toContain('dc.voxel-grid')
    expect(markup).toContain('dc.current-density')
    expect(markup).toContain('caemble.dc/current-density@1')
    expect(markup).toContain('relativeResidual')
  })

  it('shows an unavailable program state before Experiment evaluation', () => {
    const markup = renderToStaticMarkup(
      <SolverSpecSheet compatibility={{ status: 'unavailable', issues: [] }} simulationProgram={null} />,
    )

    expect(markup).toContain('Simulation unavailable')
    expect(markup).toContain('Waiting for an Experiment simulation program.')
  })

  it('groups every preflight issue by document without presenting it as an alert', () => {
    const markup = renderToStaticMarkup(
      <SolverSpecSheet
        compatibility={{
          status: 'incompatible',
          issues: [
            {
              documentType: 'structure',
              path: 'tasks.electric.initializations[0].target[0]',
              message: 'references missing structure.geometry.conductor.',
            },
            {
              documentType: 'experiment',
              path: 'tasks.electric.outputs[0].methodId',
              message: 'is not registered for this kernel.',
            },
          ],
        }}
        simulationProgram={simulationProgram}
      />,
    )

    expect(markup).toContain('Simulation incompatible')
    expect(markup).toContain('2 issues')
    expect(markup).toContain('>Structure</h4>')
    expect(markup).toContain('>Experiment</h4>')
    expect(markup).toContain('tasks.electric.initializations[0].target[0]')
    expect(markup).toContain('tasks.electric.outputs[0].methodId')
    expect(markup).not.toContain('role="alert"')
  })
})
