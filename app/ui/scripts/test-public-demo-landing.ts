import type { AvailableExperimentRecord } from '@/api'
import { defaultWorkbenchLayoutState, workbenchSectionIds, type WorkbenchDraft } from '@/features/cae-workbench/types'
import {
  draftNeedsPredictionLandingPreservation,
  predictionLandingExperiment,
} from '@/pages/cae/predictionLandingPolicy'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function experiment(id: number, options: Partial<AvailableExperimentRecord> = {}): AvailableExperimentRecord {
  return {
    id,
    namespace: 'demo',
    repository_slug: 'repo',
    experiment_key: `experiment-${id}`,
    version_major: 1,
    version_minor: 0,
    version_patch: 0,
    name: `Experiment ${id}`,
    source_bundle: { files: { 'experiment.tsx': 'export default {}' } },
    source_hash: `hash-${id}`,
    predictionReady: true,
    predictionCounts: { recordedMeasurements: 1, readyCalculations: 1, calculationData: 1 },
    demoOrder: null,
    demoDefault: false,
    ...options,
  }
}

assert(defaultWorkbenchLayoutState.activeSection === 'prediction', 'bare Workbench must start in Prediction')
assert(workbenchSectionIds.includes('admin'), 'Workbench must define the admin section')

const recent = experiment(1)
const lastReady = experiment(2)
const representative = experiment(3, { isDemo: true, demoDefault: true, demoOrder: 0 })
assert(
  predictionLandingExperiment({ mine: [recent, lastReady], demos: [representative] }, 2)?.id === 2,
  'last ready owned Experiment must win',
)
assert(
  predictionLandingExperiment({ mine: [recent], demos: [representative] }, null)?.id === 1,
  'recent owned Experiment must precede Demo',
)
assert(
  predictionLandingExperiment({ mine: [], demos: [representative] }, null)?.id === 3,
  'anonymous landing must choose the representative Demo',
)

const starterBundle = { files: { 'experiment.tsx': 'starter' } }
const draft = {
  savedAt: Date.now(),
  experiment: {
    record: null,
    baselineBundle: starterBundle,
    document: { kind: 'experiment', sourceBundle: starterBundle },
    name: 'Starter Experiment',
    description: '',
  },
  candidate: { vars: null, materialParameters: null },
  selection: { measurementId: null },
  layout: defaultWorkbenchLayoutState,
} as unknown as WorkbenchDraft
assert(!draftNeedsPredictionLandingPreservation(draft, starterBundle), 'pristine Starter may be replaced')
assert(
  draftNeedsPredictionLandingPreservation(
    { ...draft, experiment: { ...draft.experiment, name: 'My local draft' } },
    starterBundle,
  ),
  'meaningful local Draft must be preserved',
)

console.log('Public Demo landing policy tests passed.')
