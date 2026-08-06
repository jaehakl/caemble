import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAD_COMPILER_VERSION, type CompiledCadSource } from '../compiler/types'
import { buildSourceOnlyRealization, type BuiltSample, type BuiltSetup } from '../execution/realization'
import { serializeCadScene } from '../execution/mesh'
import type { EvaluatedExperimentSnapshot, EvaluatedStructureSnapshot } from '../execution/snapshot'
import type { RunnerEvaluationEnvelope, RunnerSimulationEnvelope } from './protocol'

const simulationMocks = vi.hoisted(() => ({
  preflightSimulation: vi.fn(),
  runSimulationProgram: vi.fn(),
}))

vi.mock('../../simulation', () => ({
  KernelRegistry: class KernelRegistry {},
  kernelModules: [],
  preflightSimulation: simulationMocks.preflightSimulation,
  runSimulationProgram: simulationMocks.runSimulationProgram,
}))

const responses: unknown[] = []
const workerScope = {
  onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
  postMessage(message: unknown) {
    responses.push(message)
  },
}
const nonce = '12345678-90ab-cdef-1234-567890abcdef'
const structureHash = 'c'.repeat(64)
const experimentHash = 'd'.repeat(64)
const compiledStructure: CompiledCadSource = {
  apiVersion: 3,
  compilerVersion: CAD_COMPILER_VERSION,
  entryFile: 'structure.tsx',
  sourceHash: structureHash,
  code: `
const { structure } = require('@caemble/core')
function Body({ width }) {
  return h('box', { size: [width, 1, 1] })
}
module.exports.default = structure({
  lengthUnit: 'mm',
  varsSchema: { width: { min: 1, max: 10 } },
  geometry: ({ vars }) => h(Body, { id: 'body', width: vars.width }),
})
`,
}
const compiledExperiment: CompiledCadSource = {
  apiVersion: 3,
  compilerVersion: CAD_COMPILER_VERSION,
  entryFile: 'experiment.tsx',
  sourceHash: experimentHash,
  code: `
const { experiment } = require('@caemble/core')
const { dcCurrentDensity } = require('@caemble/kernels')
module.exports.default = experiment({
  lengthUnit: 'mm',
  varsSchema: {},
  geometry: () => h('box', { id: 'fixture', size: [1, 1, 1] }),
  tasks: () => ({
    electric: dcCurrentDensity({
      parameters: {},
      initializations: [],
      boundaryConditions: [],
      outputs: [],
    }),
  }),
  recordedData: {
    measuredCurrent: {
      dtype: 'float64',
      unit: 'A',
      quantityKind: 'electromagnetism.ElectricCurrent',
    },
  },
  simulate: ({ sim, tasks }) => sim.run(tasks.electric).then((result) => result.state),
})
`,
}
const program = {
  formatVersion: 1 as const,
  programHash: experimentHash,
  tasks: {
    electric: {
      kernel: { name: 'dc-current-density', version: '0.0.0' },
      configHash: 'dc-config',
    },
  },
  recordedData: {
    measuredCurrent: {
      dtype: 'float64' as const,
      unit: 'A',
      quantityKind: 'electromagnetism.ElectricCurrent' as const,
    },
  },
}
const structureSnapshot: EvaluatedStructureSnapshot = {
  kind: 'structure',
  sourceHash: structureHash,
  seed: 7,
  variables: {},
  varsSchema: {},
  scene: serializeCadScene({
    geometryGroups: [],
    lengthUnit: 'mm',
    parts: [],
    surfaceGroups: [],
    tree: { children: [], key: 'structure', label: 'Structure' },
  }),
}
const experimentSnapshot: EvaluatedExperimentSnapshot = {
  kind: 'experiment',
  sourceHash: experimentHash,
  seed: 9,
  variables: {},
  varsSchema: {},
  scene: serializeCadScene({
    geometryGroups: [],
    lengthUnit: 'mm',
    parts: [],
    surfaceGroups: [],
    tree: { children: [], key: 'experiment', label: 'Experiment' },
  }),
  simulationProgram: program,
}
const sample = buildSourceOnlyRealization(structureSnapshot) as BuiltSample
const setup = buildSourceOnlyRealization(experimentSnapshot) as BuiltSetup

function dispatch(data: RunnerEvaluationEnvelope | RunnerSimulationEnvelope | unknown) {
  workerScope.onmessage?.({ data } as MessageEvent<unknown>)
}

describe('evaluation and simulation Worker', () => {
  let readyMessage: unknown

  beforeAll(async () => {
    vi.stubGlobal('self', workerScope)
    await import('./evaluation.worker')
    readyMessage = responses[0]
  })

  beforeEach(() => {
    responses.length = 0
    simulationMocks.preflightSimulation.mockReset()
    simulationMocks.runSimulationProgram.mockReset()
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('announces readiness and evaluates an unversioned single-file Structure', () => {
    expect(readyMessage).toEqual({ type: 'runner-worker-ready' })
    dispatch({
      type: 'evaluate',
      nonce,
      request: {
        type: 'evaluate',
        requestId: 'evaluation-1',
        revision: 2,
        document: { kind: 'structure', realizationSeed: 7 },
        compiledSource: compiledStructure,
        vars: { width: 4 },
      },
    })

    expect(responses).toHaveLength(1)
    expect(responses[0]).toMatchObject({
      type: 'evaluation-result',
      nonce,
      response: {
        type: 'evaluation-success',
        requestId: 'evaluation-1',
        revision: 2,
        documentType: 'structure',
        snapshot: {
          kind: 'structure',
          seed: 7,
          variables: { width: 4 },
        },
      },
    })
  })

  it('runs preflight against the evaluated Experiment program', async () => {
    simulationMocks.preflightSimulation.mockResolvedValue({ issues: [] })
    dispatch({
      type: 'preflight-simulation',
      nonce,
      request: {
        type: 'preflight-simulation',
        requestId: 'preflight-1',
        structureRevision: 3,
        experimentRevision: 4,
        compiledSource: compiledExperiment,
        sample,
        setup,
      },
    })

    await vi.waitFor(() => {
      expect(responses).toContainEqual({
        type: 'preflight-simulation-result',
        nonce,
        response: {
          type: 'preflight-simulation-result',
          requestId: 'preflight-1',
          structureRevision: 3,
          experimentRevision: 4,
          issues: [],
        },
      })
    })
    expect(simulationMocks.preflightSimulation).toHaveBeenCalledOnce()
  })

  it('reports progress and aborts the active run when cancellation matches its identity', async () => {
    let activeSignal: AbortSignal | undefined
    simulationMocks.runSimulationProgram.mockImplementation(
      (
        _definition,
        _sample,
        _setup,
        _registry,
        signal: AbortSignal,
        runId: string,
        options: { reportProgress: (progress: unknown) => void },
      ) => {
        activeSignal = signal
        options.reportProgress({
          runId,
          task: 'electric',
          kernel: { name: 'dc-current-density', version: '0.0.0' },
          stage: 'occupancy',
          completed: 1,
          total: 4,
        })
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), {
            once: true,
          })
        })
      },
    )
    const run: RunnerSimulationEnvelope = {
      type: 'run-simulation',
      nonce,
      request: {
        type: 'run-simulation',
        requestId: 'run-1',
        structureRevision: 5,
        experimentRevision: 6,
        compiledSource: compiledExperiment,
        sample,
        setup,
      },
    }
    dispatch(run)
    expect(responses[0]).toMatchObject({
      type: 'simulation-progress',
      requestId: 'run-1',
      progress: { task: 'electric', stage: 'occupancy' },
    })

    dispatch({
      type: 'cancel-simulation',
      nonce,
      requestId: 'another-run',
    })
    expect(activeSignal?.aborted).toBe(false)
    dispatch({
      type: 'cancel-simulation',
      nonce,
      requestId: 'run-1',
    })
    expect(activeSignal?.aborted).toBe(true)

    await vi.waitFor(() => {
      expect(responses[responses.length - 1]).toMatchObject({
        type: 'run-simulation-result',
        nonce,
        response: {
          type: 'run-simulation-error',
          requestId: 'run-1',
          message: 'cancelled',
        },
      })
    })
  })
})
