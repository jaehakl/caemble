import { assertCadSourceDocument, assertExperimentSourceBundle } from '@/lib/cad'
import {
  analysisTabIds,
  bottomDockModes,
  defaultWorkbenchLayoutState,
  experimentRightTabIds,
  helpKindIds,
  measurementRightTabIds,
  workbenchSectionIds,
  type AnalysisTabId,
  type BottomDockMode,
  type ExperimentRightTabId,
  type HelpKindId,
  type MeasurementRightTabId,
  type WorkbenchDraft,
  type WorkbenchDraftDomain,
  type WorkbenchDraftV14,
  type WorkbenchDraftV15,
  type WorkbenchLayoutState,
  type WorkbenchSectionId,
  type WorkbenchTabId,
} from '../types'

export const WORKBENCH_DRAFT_VERSION = 16 as const
export const WORKBENCH_DRAFT_STORAGE_KEY = 'caemble:cae-workbench-draft'

const v14Tabs: readonly WorkbenchTabId[] = ['experiment', 'experiments', 'recorded-data', 'ai-helper']

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validOptionalId(value: unknown) {
  return value === null || (Number.isSafeInteger(value) && Number(value) > 0)
}

function normalizeRatio(value: unknown, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, 0), 1)
}

function readDomain(value: Record<string, unknown>): WorkbenchDraftDomain | null {
  const experiment = value.experiment
  const candidate = value.candidate
  const selection = value.selection
  if (
    typeof value.savedAt !== 'number' ||
    !Number.isFinite(value.savedAt) ||
    !plainObject(experiment) ||
    typeof experiment.name !== 'string' ||
    typeof experiment.description !== 'string' ||
    !plainObject(candidate) ||
    (candidate.vars !== null && !plainObject(candidate.vars)) ||
    (candidate.materialParameters !== null && !plainObject(candidate.materialParameters)) ||
    !plainObject(selection) ||
    !validOptionalId(selection.measurementId)
  ) {
    return null
  }

  try {
    if (experiment.document !== null) assertCadSourceDocument(experiment.document)
    if (experiment.baselineBundle !== null) assertExperimentSourceBundle(experiment.baselineBundle)
    if (experiment.record !== null) {
      if (!plainObject(experiment.record)) return null
      assertExperimentSourceBundle(experiment.record.source_bundle)
    }
  } catch {
    return null
  }

  return {
    savedAt: value.savedAt,
    experiment: experiment as WorkbenchDraftDomain['experiment'],
    candidate: candidate as WorkbenchDraftDomain['candidate'],
    selection: selection as WorkbenchDraftDomain['selection'],
  }
}

function normalizeLayout(value: unknown): WorkbenchLayoutState {
  const layout = plainObject(value) ? value : {}
  const rightTabs = plainObject(layout.rightTabs) ? layout.rightTabs : {}
  const help = plainObject(layout.help) ? layout.help : {}
  const activeSection = workbenchSectionIds.includes(layout.activeSection as WorkbenchSectionId)
    ? (layout.activeSection as WorkbenchSectionId)
    : defaultWorkbenchLayoutState.activeSection
  const bottomMode = bottomDockModes.includes(layout.bottomMode as BottomDockMode)
    ? (layout.bottomMode as BottomDockMode)
    : defaultWorkbenchLayoutState.bottomMode
  const experimentRightTab = experimentRightTabIds.includes(rightTabs.experiment as ExperimentRightTabId)
    ? (rightTabs.experiment as ExperimentRightTabId)
    : defaultWorkbenchLayoutState.rightTabs.experiment
  const measurementRightTab = measurementRightTabIds.includes(rightTabs.measurement as MeasurementRightTabId)
    ? (rightTabs.measurement as MeasurementRightTabId)
    : defaultWorkbenchLayoutState.rightTabs.measurement
  const analysisTab = analysisTabIds.includes(layout.analysisTab as AnalysisTabId)
    ? (layout.analysisTab as AnalysisTabId)
    : defaultWorkbenchLayoutState.analysisTab
  const helpKind = helpKindIds.includes(help.kind as HelpKindId)
    ? (help.kind as HelpKindId)
    : defaultWorkbenchLayoutState.help.kind

  return {
    activeSection,
    activeExperimentFile:
      layout.activeExperimentFile === null || typeof layout.activeExperimentFile === 'string'
        ? layout.activeExperimentFile
        : defaultWorkbenchLayoutState.activeExperimentFile,
    materialId: validOptionalId(layout.materialId)
      ? (layout.materialId as number | null)
      : defaultWorkbenchLayoutState.materialId,
    leftWidthRatio: normalizeRatio(layout.leftWidthRatio, defaultWorkbenchLayoutState.leftWidthRatio),
    rightWidthRatio: normalizeRatio(layout.rightWidthRatio, defaultWorkbenchLayoutState.rightWidthRatio),
    bottomMode,
    bottomHeightRatio: normalizeRatio(layout.bottomHeightRatio, defaultWorkbenchLayoutState.bottomHeightRatio),
    viewerExpanded:
      typeof layout.viewerExpanded === 'boolean' ? layout.viewerExpanded : defaultWorkbenchLayoutState.viewerExpanded,
    rightTabs: { experiment: experimentRightTab, measurement: measurementRightTab },
    analysisTab,
    help: {
      kind: helpKind,
      item: help.item === null || typeof help.item === 'string' ? help.item : defaultWorkbenchLayoutState.help.item,
    },
  }
}

function readV15(value: Record<string, unknown>, domain: WorkbenchDraftDomain): WorkbenchDraftV15 | null {
  if (value.version !== 15 || !plainObject(value.layout)) return null
  return { ...domain, version: 15, layout: value.layout as WorkbenchDraftV15['layout'] }
}

function migrateV15(draft: WorkbenchDraftV15): WorkbenchDraft {
  return {
    ...draft,
    version: WORKBENCH_DRAFT_VERSION,
    layout: {
      ...normalizeLayout(draft.layout),
      leftWidthRatio: defaultWorkbenchLayoutState.leftWidthRatio,
      rightWidthRatio: defaultWorkbenchLayoutState.rightWidthRatio,
      bottomHeightRatio: defaultWorkbenchLayoutState.bottomHeightRatio,
    },
  }
}

function readV14(value: Record<string, unknown>, domain: WorkbenchDraftDomain): WorkbenchDraftV14 | null {
  const layout = value.layout
  if (
    value.version !== 14 ||
    !plainObject(layout) ||
    !Array.isArray(layout.openTabs) ||
    layout.openTabs.some((tab) => !v14Tabs.includes(tab as WorkbenchTabId)) ||
    (layout.activeTab !== null && !v14Tabs.includes(layout.activeTab as WorkbenchTabId)) ||
    (layout.experimentFile !== null && typeof layout.experimentFile !== 'string') ||
    typeof layout.splitPercent !== 'number' ||
    !Number.isFinite(layout.splitPercent)
  ) {
    return null
  }
  return {
    ...domain,
    version: 14,
    layout: layout as WorkbenchDraftV14['layout'],
  }
}

function migrateV14(draft: WorkbenchDraftV14): WorkbenchDraft {
  const activeSection: WorkbenchSectionId = draft.layout.activeTab === 'recorded-data' ? 'measurement' : 'experiment'
  return {
    savedAt: draft.savedAt,
    experiment: draft.experiment,
    candidate: draft.candidate,
    selection: draft.selection,
    version: WORKBENCH_DRAFT_VERSION,
    layout: {
      ...defaultWorkbenchLayoutState,
      activeSection,
      activeExperimentFile: draft.layout.experimentFile,
      bottomMode: draft.layout.activeTab === 'ai-helper' ? 'agent' : 'hidden',
    },
  }
}

export async function loadWorkbenchDraft(): Promise<WorkbenchDraft | null> {
  const serialized = sessionStorage.getItem(WORKBENCH_DRAFT_STORAGE_KEY)
  if (serialized === null) return null
  try {
    const stored = JSON.parse(serialized) as unknown
    if (!plainObject(stored)) throw new Error('Invalid Workbench draft.')
    const domain = readDomain(stored)
    if (!domain) throw new Error('Invalid Workbench draft domain.')

    if (stored.version === WORKBENCH_DRAFT_VERSION) {
      return {
        ...domain,
        version: WORKBENCH_DRAFT_VERSION,
        layout: normalizeLayout(stored.layout),
      }
    }

    const v15 = readV15(stored, domain)
    const v14 = readV14(stored, domain)
    const migrated = v15 ? migrateV15(v15) : v14 ? migrateV14(v14) : null
    if (!migrated) throw new Error('Unsupported Workbench draft version.')
    sessionStorage.setItem(WORKBENCH_DRAFT_STORAGE_KEY, JSON.stringify(migrated))
    return migrated
  } catch {
    sessionStorage.removeItem(WORKBENCH_DRAFT_STORAGE_KEY)
    return null
  }
}

export async function saveWorkbenchDraft(draft: WorkbenchDraft) {
  sessionStorage.setItem(WORKBENCH_DRAFT_STORAGE_KEY, JSON.stringify(draft))
}

export async function clearWorkbenchDraft() {
  sessionStorage.removeItem(WORKBENCH_DRAFT_STORAGE_KEY)
}
