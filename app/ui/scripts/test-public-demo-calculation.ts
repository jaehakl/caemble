import { readFileSync } from 'node:fs'
import { calculationAccessPolicy } from '@/features/calculation/calculationAccessPolicy'

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

const adminDemo = calculationAccessPolicy({
  dataReadable: true,
  experimentIsDemo: true,
  experimentManageable: true,
})
assert(!adminDemo.demoSandbox, 'admin Demo editing must not use the local-only sandbox')
assert(adminDemo.sourceEditable, 'admin Demo Calculation source must be editable')
assert(adminDemo.persistable, 'admin Demo Calculations must be persistable')

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

const workbenchSource = readFileSync('src/features/calculation/CalculationWorkbench.tsx', 'utf8')
const pageSource = readFileSync('src/workbench/CaeWorkbenchRoute.tsx', 'utf8')
const chromeSource = readFileSync('src/features/cae-workbench/useCaePageChrome.tsx', 'utf8')
const predictionSource = readFileSync('src/features/prediction/PredictionWorkspace.tsx', 'utf8')
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
  ) && /replaceDraft\(calculationDraftFromRecord\(rows\[0\]\), rows\[0\]\.id, rows\[0\]\)/u.test(workbenchSource),
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
assert(
  /user\.roles\.includes\('admin'\) \|\| \(!experimentRecord\.isDemo && experimentRecord\.user_id === user\.id\)/u.test(
    stateSource,
  ),
  'only admins or non-Demo owners must receive persistent Experiment access',
)
assert(
  /publicDemoMutable=\{workbench\.experimentIsDemo && workbench\.experimentManageable\}/u.test(pageSource),
  'admin Demo mutations must carry the public-data warning context',
)
assert(
  /workbench\.experimentIsDemo && !workbench\.experimentManageable/u.test(chromeSource),
  'Demo ribbon actions must remain read-only only for non-admin viewers',
)
assert(
  /if \(!workbench\.experimentManageable\) return '이 Experiment의 데이터를 변경할 권한이 없습니다\.'/u.test(
    predictionSource,
  ) && /!workbench\.experimentManageable \|\|[\s\S]*?workbench\.measurementActions\.busy/u.test(predictionSource),
  'Prediction validation and missing-data writes must require persistent Experiment access',
)

console.log('Public Demo Calculation access tests passed.')
