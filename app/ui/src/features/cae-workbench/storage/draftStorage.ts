import { z } from 'zod'
import { savedExperimentRecordSchema } from '@/contracts/api/experimentValidators'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import type { WorkbenchDraft, WorkbenchSelectionContext } from '../types'
import {
  analysisTabIds,
  bottomDockModes,
  defaultWorkbenchLayoutState,
  experimentRightTabIds,
  helpKindIds,
  measurementRightTabIds,
  workbenchSectionIds,
} from '../types'

export const WORKBENCH_DRAFT_STORAGE_KEY = 'caemble:workbench-draft'
export const WORKBENCH_DRAFT_SCHEMA_VERSION = 3 as const
const RETIRED_DRAFT_KEYS = ['caemble:cae-workbench-draft', 'caemble:cae-workbench-draft:v1', 'caemble.ai-helper.agent-session', 'caemble.ai-helper.conversation-v1'] as const

const sourceBundleSchema = z.object({ files: z.record(z.string(), z.string()) }).passthrough()
const ratioSchema = z.number().finite().min(0).max(1)
const tensorSchema: z.ZodType<unknown> = z.lazy(() => z.union([z.number().finite(), z.array(tensorSchema)]))
const materialSnapshotSchema = z.object({
  materials: z.record(z.string(), z.object({
    color: z.string().optional(),
    models: z.record(z.string(), z.object({ model: z.string(), parameters: z.record(z.string(), z.unknown()) }).strict()),
  }).strict()),
}).strict()
const storedDraftBaseSchema = z
  .object({
    savedAt: z.number().finite(),
    experiment: z.object({
      record: savedExperimentRecordSchema.nullable(),
      baselineBundle: sourceBundleSchema.nullable(),
      document: z.object({ kind: z.literal('experiment'), sourceBundle: sourceBundleSchema }).passthrough().nullable(),
      name: z.string(),
      description: z.string(),
    }),
    candidate: z.object({
      vars: z.record(z.string(), tensorSchema).nullable(),
      materialSnapshot: z
        .object({
          experiment: materialSnapshotSchema,
          tasks: z.record(z.string(), materialSnapshotSchema),
          sourceHash: z.string(), varsHash: z.string(), modelDefinitions: z.array(z.unknown()),
          selections: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.record(z.string(), z.string())))),
        })
        .passthrough()
        .nullable(),
    }),
    layout: z.preprocess(
      (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value
        const layout = value as Record<string, unknown>
        if (layout.activeSection !== 'material') return value
        return { ...layout, activeSection: 'help', help: { kind: 'materials', item: null } }
      },
      z
        .object({
          activeSection: z.enum(workbenchSectionIds).catch(defaultWorkbenchLayoutState.activeSection),
          activeExperimentFile: z.string().nullable(),
          leftWidthRatio: ratioSchema.catch(defaultWorkbenchLayoutState.leftWidthRatio),
          rightWidthRatio: ratioSchema.catch(defaultWorkbenchLayoutState.rightWidthRatio),
          calculationColumnRatios: z
            .tuple([ratioSchema, ratioSchema, ratioSchema, ratioSchema])
            .catch([...defaultWorkbenchLayoutState.calculationColumnRatios!] as [number, number, number, number]),
          calculationLeftRowRatios: z
            .tuple([ratioSchema, ratioSchema, ratioSchema])
            .catch([...defaultWorkbenchLayoutState.calculationLeftRowRatios!] as [number, number, number]),
          calculationOutputChartRatio: ratioSchema.catch(defaultWorkbenchLayoutState.calculationOutputChartRatio!),
          bottomMode: z.preprocess(
            (value) => (value === 'agent' ? 'console' : value),
            z.enum(bottomDockModes).catch(defaultWorkbenchLayoutState.bottomMode),
          ),
          bottomHeightRatio: ratioSchema.catch(defaultWorkbenchLayoutState.bottomHeightRatio),
          viewerExpanded: z.boolean(),
          rightTabs: z.object({
            experiment: z.enum(experimentRightTabIds).catch(defaultWorkbenchLayoutState.rightTabs.experiment),
            measurement: z.enum(measurementRightTabIds).catch(defaultWorkbenchLayoutState.rightTabs.measurement),
          }),
          analysisTab: z.enum(analysisTabIds).catch(defaultWorkbenchLayoutState.analysisTab),
          help: z.object({
            kind: z.enum(helpKindIds).catch(defaultWorkbenchLayoutState.help.kind),
            item: z.string().nullable(),
          }),
        })
        .passthrough(),
    ),
  })
  .passthrough()

const storedDraftSchema = storedDraftBaseSchema.extend({
  selection: z.object({
    experimentId: z.number().int().positive().nullable(),
    measurementId: z.number().int().positive().nullable(),
    calculationId: z.number().int().positive().nullable(),
  }),
})
const storedDraftEnvelopeSchema = z
  .object({ version: z.literal(WORKBENCH_DRAFT_SCHEMA_VERSION), ownerScope: z.string().min(1), draft: storedDraftSchema })
  .passthrough()

function normalizeStoredDraft(
  draft: z.infer<typeof storedDraftSchema>,
): WorkbenchDraft {
  const experimentId = draft.experiment.record?.id ?? null
  const selection: WorkbenchSelectionContext = experimentId !== null && draft.selection.experimentId === experimentId
    ? { ...draft.selection, experimentId }
    : { experimentId, measurementId: null, calculationId: null }
  return { ...draft, selection } as WorkbenchDraft
}

export function workbenchDraftStorageKey(ownerScope: PrivateQueryScope) {
  return `${WORKBENCH_DRAFT_STORAGE_KEY}:${encodeURIComponent(ownerScope)}`
}

export async function loadWorkbenchDraft(ownerScope: PrivateQueryScope): Promise<WorkbenchDraft | null> {
  const storageKey = workbenchDraftStorageKey(ownerScope)
  sessionStorage.removeItem(WORKBENCH_DRAFT_STORAGE_KEY)
  RETIRED_DRAFT_KEYS.forEach((key) => sessionStorage.removeItem(key))
  const serialized = sessionStorage.getItem(storageKey)
  if (serialized === null) return null
  try {
    const envelope = storedDraftEnvelopeSchema.parse(JSON.parse(serialized))
    if (envelope.ownerScope !== ownerScope) throw new Error('Draft belongs to another scope.')
    return normalizeStoredDraft(envelope.draft)
  } catch {
    sessionStorage.removeItem(storageKey)
    return null
  }
}

export async function saveWorkbenchDraft(ownerScope: PrivateQueryScope, draft: WorkbenchDraft) {
  const normalizedDraft = normalizeStoredDraft(storedDraftSchema.parse(draft))
  sessionStorage.setItem(
    workbenchDraftStorageKey(ownerScope),
    JSON.stringify({ version: WORKBENCH_DRAFT_SCHEMA_VERSION, ownerScope, draft: normalizedDraft }),
  )
}

export async function clearWorkbenchDraft(ownerScope: PrivateQueryScope) {
  sessionStorage.removeItem(workbenchDraftStorageKey(ownerScope))
  RETIRED_DRAFT_KEYS.forEach((key) => sessionStorage.removeItem(key))
}
