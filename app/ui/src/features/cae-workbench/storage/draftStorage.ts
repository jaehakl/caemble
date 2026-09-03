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
export const WORKBENCH_DRAFT_SCHEMA_VERSION = 2 as const
const RETIRED_DRAFT_KEYS = ['caemble:cae-workbench-draft', 'caemble:cae-workbench-draft:v1'] as const

const sourceBundleSchema = z.object({ files: z.record(z.string(), z.string()) }).passthrough()
const ratioSchema = z.number().finite().min(0).max(1)
const tensorSchema: z.ZodType<unknown> = z.lazy(() => z.union([z.number().finite(), z.array(tensorSchema)]))
const frozenMaterialParametersSchema = z
  .object({
    materials: z.record(z.string(), z.record(z.string(), z.unknown())),
    materialColors: z
      .record(
        z.string(),
        z.object({ color: z.string(), materialId: z.number().int().positive() }).passthrough(),
      )
      .optional(),
  })
  .passthrough()
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
      materialParameters: z
        .object({
          experiment: frozenMaterialParametersSchema,
          tasks: z.record(z.string(), frozenMaterialParametersSchema),
        })
        .passthrough()
        .nullable(),
    }),
    layout: z
      .object({
        activeSection: z.enum(workbenchSectionIds).catch(defaultWorkbenchLayoutState.activeSection),
        activeExperimentFile: z.string().nullable(),
        materialId: z.number().int().positive().nullable(),
        leftWidthRatio: ratioSchema.catch(defaultWorkbenchLayoutState.leftWidthRatio),
        rightWidthRatio: ratioSchema.catch(defaultWorkbenchLayoutState.rightWidthRatio),
        calculationColumnRatios: z
          .tuple([ratioSchema, ratioSchema, ratioSchema, ratioSchema])
          .catch([...defaultWorkbenchLayoutState.calculationColumnRatios!] as [number, number, number, number]),
        calculationLeftRowRatios: z
          .tuple([ratioSchema, ratioSchema, ratioSchema])
          .catch([...defaultWorkbenchLayoutState.calculationLeftRowRatios!] as [number, number, number]),
        calculationOutputChartRatio: ratioSchema.catch(defaultWorkbenchLayoutState.calculationOutputChartRatio!),
        bottomMode: z.enum(bottomDockModes).catch(defaultWorkbenchLayoutState.bottomMode),
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
  })
  .passthrough()

const storedDraftV1Schema = storedDraftBaseSchema.extend({
  selection: z.object({ measurementId: z.number().int().positive().nullable() }),
})
const storedDraftV2Schema = storedDraftBaseSchema.extend({
  selection: z.object({
    experimentId: z.number().int().positive().nullable(),
    measurementId: z.number().int().positive().nullable(),
    calculationId: z.number().int().positive().nullable(),
  }),
})
const storedDraftEnvelopeV1Schema = z
  .object({ version: z.literal(1), ownerScope: z.string().min(1), draft: storedDraftV1Schema })
  .passthrough()
const storedDraftEnvelopeV2Schema = z
  .object({ version: z.literal(WORKBENCH_DRAFT_SCHEMA_VERSION), ownerScope: z.string().min(1), draft: storedDraftV2Schema })
  .passthrough()

function normalizeStoredDraft(
  draft: z.infer<typeof storedDraftV1Schema> | z.infer<typeof storedDraftV2Schema>,
): WorkbenchDraft {
  const experimentId = draft.experiment.record?.id ?? null
  const v2Selection = 'experimentId' in draft.selection ? draft.selection : null
  const selection: WorkbenchSelectionContext =
    experimentId === null
      ? { experimentId: null, measurementId: null, calculationId: null }
      : v2Selection === null
        ? { experimentId, measurementId: draft.selection.measurementId, calculationId: null }
        : v2Selection.experimentId === experimentId
          ? { ...v2Selection, experimentId }
          : { experimentId, measurementId: null, calculationId: null }
  return { ...draft, selection } as WorkbenchDraft
}

export function workbenchDraftStorageKey(ownerScope: PrivateQueryScope) {
  return `${WORKBENCH_DRAFT_STORAGE_KEY}:${encodeURIComponent(ownerScope)}`
}

export async function loadWorkbenchDraft(
  ownerScope: PrivateQueryScope,
  confirmUnownedLegacyMigration?: () => boolean,
): Promise<WorkbenchDraft | null> {
  const storageKey = workbenchDraftStorageKey(ownerScope)
  const serialized = sessionStorage.getItem(storageKey)
  if (serialized === null) {
    const legacySerialized = sessionStorage.getItem(WORKBENCH_DRAFT_STORAGE_KEY)
    RETIRED_DRAFT_KEYS.forEach((key) => sessionStorage.removeItem(key))
    if (legacySerialized === null) return null
    try {
      const parsed = JSON.parse(legacySerialized)
      const v2Result = storedDraftV2Schema.safeParse(parsed)
      const draft = normalizeStoredDraft(v2Result.success ? v2Result.data : storedDraftV1Schema.parse(parsed))
      if (!confirmUnownedLegacyMigration?.()) return null
      await saveWorkbenchDraft(ownerScope, draft)
      sessionStorage.removeItem(WORKBENCH_DRAFT_STORAGE_KEY)
      return draft
    } catch {
      sessionStorage.removeItem(WORKBENCH_DRAFT_STORAGE_KEY)
      return null
    }
  }
  RETIRED_DRAFT_KEYS.forEach((key) => sessionStorage.removeItem(key))
  try {
    const parsed = JSON.parse(serialized)
    const v2Result = storedDraftEnvelopeV2Schema.safeParse(parsed)
    if (v2Result.success) {
      if (v2Result.data.ownerScope !== ownerScope) {
        sessionStorage.removeItem(storageKey)
        return null
      }
      return normalizeStoredDraft(v2Result.data.draft)
    }
    const v1Envelope = storedDraftEnvelopeV1Schema.parse(parsed)
    if (v1Envelope.ownerScope !== ownerScope) {
      sessionStorage.removeItem(storageKey)
      return null
    }
    const draft = normalizeStoredDraft(v1Envelope.draft)
    await saveWorkbenchDraft(ownerScope, draft)
    return draft
  } catch {
    sessionStorage.removeItem(storageKey)
    return null
  }
}

export async function saveWorkbenchDraft(ownerScope: PrivateQueryScope, draft: WorkbenchDraft) {
  const normalizedDraft = normalizeStoredDraft(storedDraftV2Schema.parse(draft))
  sessionStorage.setItem(
    workbenchDraftStorageKey(ownerScope),
    JSON.stringify({ version: WORKBENCH_DRAFT_SCHEMA_VERSION, ownerScope, draft: normalizedDraft }),
  )
}

export async function clearWorkbenchDraft(ownerScope: PrivateQueryScope) {
  sessionStorage.removeItem(workbenchDraftStorageKey(ownerScope))
  RETIRED_DRAFT_KEYS.forEach((key) => sessionStorage.removeItem(key))
}
