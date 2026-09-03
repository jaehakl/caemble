import { z } from 'zod'
import { savedExperimentRecordSchema } from '@/contracts/api/experimentValidators'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import type { WorkbenchDraft } from '../types'
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
const WORKBENCH_DRAFT_SCHEMA_VERSION = 1 as const
const RETIRED_DRAFT_KEYS = [
  'caemble:cae-workbench-draft',
  'caemble:cae-workbench-draft:v1',
] as const

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
const storedDraftSchema = z
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
    selection: z.object({ measurementId: z.number().int().positive().nullable() }),
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

const storedDraftEnvelopeSchema = z
  .object({
    version: z.literal(WORKBENCH_DRAFT_SCHEMA_VERSION),
    ownerScope: z.string().min(1),
    draft: storedDraftSchema,
  })
  .passthrough()

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
      const draft = storedDraftSchema.parse(JSON.parse(legacySerialized)) as WorkbenchDraft
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
    const envelope = storedDraftEnvelopeSchema.parse(JSON.parse(serialized))
    if (envelope.ownerScope !== ownerScope) {
      sessionStorage.removeItem(storageKey)
      return null
    }
    return envelope.draft as WorkbenchDraft
  } catch {
    sessionStorage.removeItem(storageKey)
    return null
  }
}

export async function saveWorkbenchDraft(ownerScope: PrivateQueryScope, draft: WorkbenchDraft) {
  sessionStorage.setItem(
    workbenchDraftStorageKey(ownerScope),
    JSON.stringify({ version: WORKBENCH_DRAFT_SCHEMA_VERSION, ownerScope, draft }),
  )
}

export async function clearWorkbenchDraft(ownerScope: PrivateQueryScope) {
  sessionStorage.removeItem(workbenchDraftStorageKey(ownerScope))
  RETIRED_DRAFT_KEYS.forEach((key) => sessionStorage.removeItem(key))
}
