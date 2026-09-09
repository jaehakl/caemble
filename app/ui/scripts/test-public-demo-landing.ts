import { experimentManagerListing } from '@/features/experiment/managerListing'
import { readFileSync } from 'node:fs'
import type { AvailableExperimentRecord } from '@/api'
import { defaultWorkbenchLayoutState, workbenchSectionIds, type WorkbenchDraft } from '@/features/cae-workbench/types'
import { draftNeedsLandingPreservation } from '@/features/cae-workbench/experimentLandingPolicy'

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

assert(defaultWorkbenchLayoutState.activeSection === 'experiment', 'bare Workbench must start in Experiment')
assert(workbenchSectionIds.includes('admin'), 'Workbench must define the admin section')

const recent = experiment(1)
const lastReady = experiment(2)
const representative = experiment(3, { isDemo: true, demoDefault: true, demoOrder: 0 })
assert(
  experimentManagerListing({ mine: [lastReady, recent], demos: [representative] }).versions[0]?.name === recent.name,
  'first sorted owned Experiment must win',
)
assert(
  experimentManagerListing({ mine: [recent], demos: [representative] }).versions[0]?.name === recent.name,
  'recent owned Experiment must precede Demo',
)
assert(
  experimentManagerListing({ mine: [], demos: [representative] }).versions[0]?.name === representative.name,
  'anonymous landing must choose the first sorted Demo',
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
  candidate: { vars: null, materialSnapshot: null },
  selection: { measurementId: null },
  layout: defaultWorkbenchLayoutState,
} as unknown as WorkbenchDraft
assert(!draftNeedsLandingPreservation(draft, starterBundle), 'pristine Starter may be replaced')
assert(
  draftNeedsLandingPreservation(
    { ...draft, experiment: { ...draft.experiment, name: 'My local draft' } },
    starterBundle,
  ),
  'meaningful local Draft must be preserved',
)

const varsPanelSource = readFileSync('src/features/calculation/VarsPanel.tsx', 'utf8')
const predictionPanelsSource = readFileSync('src/features/prediction/PredictionPanels.tsx', 'utf8')
assert(
  /expandFirstByDefault = false/u.test(varsPanelSource),
  'shared Vars panels must remain collapsed unless the caller opts in',
)
assert(
  /previousDefaultExpandedKeyRef\.current === null && defaultExpandedKey !== null/u.test(varsPanelSource),
  'the first available Prediction feature must expand once without reopening after a manual collapse',
)
assert(
  /<VarsPanel[\s\S]*?expandFirstByDefault[\s\S]*?schema=\{schema\}/u.test(predictionPanelsSource),
  'Prediction must opt into expanding its first feature',
)

console.log('Public Demo landing policy tests passed.')
