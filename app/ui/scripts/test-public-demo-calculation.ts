import { readFileSync } from 'node:fs'
import { calculationAccessPolicy } from '@/features/cae-workbench/calculation/calculationAccessPolicy'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const anonymousDemo = calculationAccessPolicy({
  dataReadable: true,
  experimentIsDemo: true,
  experimentManageable: false,
})
assert(anonymousDemo.demoSandbox, 'anonymous Demo must use the local Calculation sandbox')
assert(anonymousDemo.sourceEditable, 'anonymous Demo Calculation source must be editable locally')
assert(!anonymousDemo.persistable, 'anonymous Demo Calculation must not be persisted')

const authenticatedDemo = calculationAccessPolicy({
  dataReadable: true,
  experimentIsDemo: true,
  experimentManageable: false,
})
assert(authenticatedDemo.sourceEditable, 'authenticated Demo viewers must keep the same local sandbox')
assert(!authenticatedDemo.persistable, 'authenticated Demo viewers must not mutate the Demo')

const owner = calculationAccessPolicy({
  dataReadable: true,
  experimentIsDemo: false,
  experimentManageable: true,
})
assert(owner.sourceEditable && owner.persistable, 'owned non-Demo Calculations must remain editable and persistable')

const anonymousPrivate = calculationAccessPolicy({
  dataReadable: false,
  experimentIsDemo: false,
  experimentManageable: false,
})
assert(!anonymousPrivate.sourceEditable, 'private Calculations must remain unavailable to anonymous users')
assert(!anonymousPrivate.persistable, 'private Calculations must remain non-persistable to anonymous users')

const workbenchSource = readFileSync('src/features/cae-workbench/calculation/CalculationWorkbench.tsx', 'utf8')
const pageSource = readFileSync('src/pages/cae/CaePage.tsx', 'utf8')
const stateSource = readFileSync('src/features/cae-workbench/state/useCaeWorkbenchState.ts', 'utf8')
assert(
  /null_filter: \{ recorded_at: 'is_not_null' as const \}/u.test(workbenchSource) &&
    /limit: 1/u.test(workbenchSource) &&
    /sort: \['updated_at', 'desc'\] as const/u.test(workbenchSource),
  'Calculation must request the latest Recorded Measurement as its default',
)
assert(
  /if \(measurementId !== null\) \{[\s\S]*?defaultMeasurementExperimentRef\.current = experimentId/u.test(
    workbenchSource,
  ) && /onSelectMeasurement\(defaultMeasurement\)/u.test(workbenchSource),
  'an existing or restored Measurement must take precedence over the default',
)
assert(
  /if \(selectedCalculationId !== null\) \{[\s\S]*?defaultCalculationExperimentRef\.current = experimentId/u.test(
    workbenchSource,
  ) && /replaceDraft\(calculationDraft\(rows\[0\]\), rows\[0\]\.id\)/u.test(workbenchSource),
  'an existing or restored Calculation must take precedence over the first list item',
)
assert(
  /defaultCalculationExperimentRef\.current === experimentId/u.test(workbenchSource) &&
    /defaultMeasurementExperimentRef\.current === experimentId/u.test(workbenchSource),
  'automatic selections must run only once per Experiment context',
)
assert(
  /measurementSelectionPending=\{workbench\.selectionRestoring\}/u.test(pageSource) &&
    /pendingMeasurementId !== null \|\| selectionRestoreStatus === 'restoring'/u.test(stateSource),
  'URL Measurement restoration must block the automatic default selection',
)

console.log('Public Demo Calculation access tests passed.')
