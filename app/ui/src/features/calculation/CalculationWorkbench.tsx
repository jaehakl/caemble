import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FilePlus2, LoaderCircle, RotateCcw, Sparkles, Trash2, X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'
import { dbTables, getListRequest, type CalculationOutputLayout, type ExperimentRecordedDataRecord } from '@/api'
import type { AiAgentApplyRequest, AiAgentApplyResult } from '@/api/aiAgent'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { usePrivateQueryScope } from '@/features/auth/use-auth'
import { MeasurementExplorer } from '@/features/measurement'
import type { BottomDockMode, SavedMeasurement, SavedRecordedData } from '@/features/cae-workbench/types'
import { CadDiffEditor } from '@/features/viewer/editor/CadDiffEditor'
import {
  analyzeCalculationDependencies,
  calculationExperimentRecordReference,
  calculationInputBindingName,
  calculationSourceSkeleton,
  calculationSourceHash,
} from '@/lib/calculation'
import type { RecordedData, RecordedDataRule, Tensor, Vars, VarsSchemaEntry } from '@/lib/cad/model'
import { cn } from '@/lib/utils'
import { buildCalculationRecordedData, summarizeCalculationRecordedData } from './calculationRecordedData'
import {
  calculationDraftFromRecord,
  calculationEditingReducer,
  emptyCalculationDraft,
  initialCalculationEditingState,
  selectCalculationEditing,
  type CalculationDraft,
  type SavedCalculation,
} from './calculationEditingState'
import { calculationScalarsQueryOptions, calculationsQueryOptions } from './queryOptions'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { ResizableCalculationOutput } from './ResizableCalculationOutput'
import { CalculationSaveDialog, type CalculationSaveValues } from './CalculationSaveDialog'
import { ExperimentRecordCatalog } from './ExperimentRecordCatalog'
import { buildExperimentRecordCatalogItems, requiredCalculationRecordedDataRules } from './experimentRecordCatalogModel'
import { CalculationSourceEditor, type CalculationSourceEditorHandle } from './CalculationSourceEditor'
import { ResizableCalculationLayout } from './ResizableCalculationLayout'
import { useCalculationPreview } from './useCalculationPreview'
import { VarsPanel } from './VarsPanel'
import { compatibleVarsResetValues } from './varsTensor'
import { experimentRecordsQueryOptions } from '../experiment/queryOptions'
import { measurementsQueryOptions } from '../measurement/queryOptions'
import { invalidateCalculationMutation } from './queryInvalidation'

export type CalculationSaveState = Readonly<{
  disabled: boolean
  disabledReason?: string
}>

export type CalculationAgentBridge = Readonly<{
  calculationId: number | null
  experimentId: number
  name: string
  description: string
  sourceCode: string
  baseHash: string | null
  context: Readonly<Record<string, unknown>>
  editable: boolean
  targetLabel: string
  workspaceSession: number
  apply: (request: AiAgentApplyRequest) => Promise<AiAgentApplyResult>
}>

function calculationChangedLines(before: string, after: string) {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  let prefix = 0
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix])
    prefix++
  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - suffix - 1] === afterLines[afterLines.length - suffix - 1]
  ) {
    suffix++
  }
  return { addedLines: afterLines.length - prefix - suffix, removedLines: beforeLines.length - prefix - suffix }
}

export type CalculationWorkbenchProps = Readonly<{
  authenticated: boolean
  dataReadable: boolean
  agentWorkspaceSession: number
  bottom: ReactNode
  bottomHeightRatio: number
  bottomMode: BottomDockMode
  busy: boolean
  calculationDataBusy: boolean
  candidateEditingDisabled: boolean
  candidateSessionKey: string
  candidateVars: Readonly<Vars> | null
  columnRatios: readonly number[]
  contextPending: boolean
  persistable: boolean
  sourceEditable: boolean
  experimentId: number | null
  measurementId: number | null
  measurementLoading: boolean
  measurementSelectionPending: boolean
  menubar: ReactNode
  onActivity: RuntimeActivityCallback
  onAgentBridgeChange: (bridge: CalculationAgentBridge | null) => void
  onCalculationIdChange: (calculationId: number | null) => void
  onBottomHeightRatioChange: (ratio: number) => void
  onCandidateVariableChange: (key: string, value: Tensor) => void
  onColumnRatiosChange: (ratios: readonly [number, number, number, number]) => void
  onDeleteMeasurements: (rows: readonly SavedMeasurement[]) => Promise<boolean>
  onDirtyChange: (dirty: boolean) => void
  onOutputChartRatioChange: (ratio: number) => void
  onRequestLogin: () => void
  onRowRatiosChange: (ratios: readonly [number, number, number]) => void
  onSaveStateChange: (state: CalculationSaveState) => void
  onUsageChanged: () => Promise<void>
  publicDemoMutable: boolean
  onSelectMeasurement: (row: SavedMeasurement) => void
  onClearMeasurement: () => void
  recordedData: RecordedData | null | undefined
  recordedRows: readonly SavedRecordedData[]
  recordedRules: readonly RecordedDataRule[]
  ribbon: ReactNode
  rowRatios: readonly number[]
  saveCommand: number
  outputChartRatio: number
  selectedCalculationId: number | null
  varsSchema: Readonly<Record<string, VarsSchemaEntry>> | null
  viewer: ReactNode
  viewerExpanded: boolean
}>

export function CalculationWorkbench({
  authenticated,
  dataReadable,
  agentWorkspaceSession,
  bottom,
  bottomHeightRatio,
  bottomMode,
  busy,
  calculationDataBusy,
  candidateEditingDisabled,
  candidateSessionKey,
  candidateVars,
  columnRatios,
  contextPending,
  persistable,
  sourceEditable,
  experimentId,
  measurementId,
  measurementLoading,
  measurementSelectionPending,
  menubar,
  onActivity,
  onAgentBridgeChange,
  onCalculationIdChange,
  onBottomHeightRatioChange,
  onCandidateVariableChange,
  onColumnRatiosChange,
  onDeleteMeasurements,
  onDirtyChange,
  onOutputChartRatioChange,
  onRequestLogin,
  onRowRatiosChange,
  onSaveStateChange,
  onUsageChanged,
  publicDemoMutable,
  onSelectMeasurement,
  onClearMeasurement,
  recordedData,
  recordedRows,
  recordedRules,
  ribbon,
  rowRatios,
  saveCommand,
  outputChartRatio,
  selectedCalculationId,
  varsSchema,
  viewer,
  viewerExpanded,
}: CalculationWorkbenchProps) {
  const queryClient = useQueryClient()
  const queryScope = usePrivateQueryScope()
  const [editing, dispatchEditing] = useReducer(calculationEditingReducer, initialCalculationEditingState)
  const { agentChange, agentDiffOpen, dirty, draft, targetSession } = selectCalculationEditing(editing)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [agentIdentity, setAgentIdentity] = useState<Readonly<{ sourceCode: string; hash: string }> | null>(null)
  const [inputPanel, setInputPanel] = useState<'measurements' | 'vars'>('measurements')
  const draftRef = useRef(draft)
  const sourceEditableRef = useRef(sourceEditable)
  const calculationDataBusyRef = useRef(calculationDataBusy)
  draftRef.current = draft
  sourceEditableRef.current = sourceEditable
  calculationDataBusyRef.current = calculationDataBusy
  const appliedExperimentRef = useRef(experimentId)
  const selectedCalculationRef = useRef(selectedCalculationId)
  const defaultCalculationExperimentRef = useRef<number | null>(null)
  const defaultMeasurementExperimentRef = useRef<number | null>(null)
  const mutationSequenceRef = useRef(0)
  const appliedSaveCommandRef = useRef(saveCommand)
  const sourceEditorRef = useRef<CalculationSourceEditorHandle | null>(null)
  const calculationWorkspaceSession = agentWorkspaceSession * 1_000_000 + targetSession
  const demoSandbox = sourceEditable && !persistable
  const baseSaveDisabledReason = !authenticated
    ? '로그인 후 사용할 수 있습니다.'
    : experimentId === null
      ? '먼저 저장된 Experiment를 여세요.'
      : !persistable
        ? demoSandbox
          ? '공개 Demo Calculation은 저장할 수 없습니다. 로컬 미리보기만 사용할 수 있습니다.'
          : '이 Experiment의 Calculation을 저장할 권한이 없습니다.'
        : contextPending || selectedCalculationId !== draft.id
          ? 'Calculation context를 불러오는 중입니다.'
          : calculationDataBusy
            ? 'CalculationData 작업이 진행 중입니다.'
            : saving
              ? 'Calculation 저장이 진행 중입니다.'
              : deleting
                ? 'Calculation 삭제가 진행 중입니다.'
                : undefined
  const request = useMemo(
    () => ({
      ...getListRequest('visible', selectedCalculationId ? [selectedCalculationId] : []),
      limit: null,
      filter: { experiment_id: [experimentId, experimentId] },
      sort: ['updated_at', 'desc'] as const,
    }),
    [experimentId, selectedCalculationId],
  )
  const calculationsQuery = useQuery({
    ...calculationsQueryOptions(queryScope, experimentId, request),
    enabled: dataReadable && experimentId !== null,
  })
  const rows = useMemo(
    () => (calculationsQuery.data?.items ?? []).filter((row): row is SavedCalculation => typeof row.id === 'number'),
    [calculationsQuery.data?.items],
  )
  const defaultMeasurementRequest = useMemo(
    () => ({
      ...getListRequest('visible'),
      limit: 1,
      filter: { experiment_id: [experimentId, experimentId] },
      null_filter: { recorded_at: 'is_not_null' as const },
      sort: ['updated_at', 'desc'] as const,
    }),
    [experimentId],
  )
  const defaultMeasurementQuery = useQuery({
    ...measurementsQueryOptions(queryScope, experimentId, defaultMeasurementRequest),
    enabled:
      dataReadable &&
      experimentId !== null &&
      measurementId === null &&
      !measurementLoading &&
      !measurementSelectionPending &&
      !contextPending,
  })
  const defaultMeasurement = defaultMeasurementQuery.data?.items.find(
    (row): row is SavedMeasurement => typeof row.id === 'number',
  )
  const resetMeasurementsRequest = useMemo(
    () => ({
      ...getListRequest('visible'),
      limit: null,
      filter: { experiment_id: [experimentId, experimentId] },
      null_filter: { recorded_at: 'is_not_null' as const },
      sort: ['id', 'asc'] as const,
    }),
    [experimentId],
  )
  const resetMeasurementsQuery = useQuery({
    ...measurementsQueryOptions(queryScope, experimentId, resetMeasurementsRequest),
    enabled: dataReadable && experimentId !== null && inputPanel === 'vars' && varsSchema !== null,
  })
  const candidateResetValues = useMemo(
    () =>
      compatibleVarsResetValues(
        (resetMeasurementsQuery.data?.items ?? []).flatMap((measurement) =>
          measurement.vars ? [measurement.vars as Readonly<Vars>] : [],
        ),
        varsSchema ?? {},
      ),
    [resetMeasurementsQuery.data?.items, varsSchema],
  )
  const experimentRecordsQuery = useQuery({
    ...experimentRecordsQueryOptions(queryScope, experimentId),
    enabled: dataReadable && experimentId !== null,
  })
  const experimentRecords = useMemo(
    () => experimentRecordsQuery.data?.items ?? Object.freeze([] as ExperimentRecordedDataRecord[]),
    [experimentRecordsQuery.data?.items],
  )
  const dependencyState = useMemo(() => {
    try {
      return {
        error: null,
        names: analyzeCalculationDependencies(
          draft.sourceCode,
          experimentRecords.map((record) => record.name),
        ),
      }
    } catch (cause: unknown) {
      return {
        error: cause instanceof Error ? cause : new Error(String(cause)),
        names: Object.freeze([] as string[]),
      }
    }
  }, [draft.sourceCode, experimentRecords])
  const requiredRules = useMemo(
    () => requiredCalculationRecordedDataRules(recordedRules, dependencyState.names),
    [dependencyState.names, recordedRules],
  )
  const inputBindingState = useMemo(() => {
    try {
      return { error: null, name: calculationInputBindingName(draft.sourceCode) }
    } catch (cause: unknown) {
      return { error: cause instanceof Error ? cause.message : String(cause), name: null }
    }
  }, [draft.sourceCode])
  const recordedSnapshot = useMemo(
    () => buildCalculationRecordedData(requiredRules, recordedData),
    [recordedData, requiredRules],
  )
  const { invalidatePreview, preview } = useCalculationPreview({
    calculationDataBusy,
    contextPending,
    dependencyError: dependencyState.error,
    draft,
    experimentId,
    experimentRecordsPending: experimentRecordsQuery.isPending,
    measurementId,
    measurementLoading,
    onActivity,
    recordedSnapshot,
    selectedCalculationId,
  })
  const selectedRow = rows.find((row) => row.id === draft.id) ?? null
  const requiresPreflight =
    draft.id === null ||
    selectedRow === null ||
    selectedRow.contract_status !== 'ready' ||
    selectedRow.source_code !== draft.sourceCode
  const saveDisabledReason =
    baseSaveDisabledReason ??
    (experimentRecordsQuery.isPending
      ? 'ExperimentRecord 계약을 불러오는 중입니다.'
      : dependencyState.error
        ? dependencyState.error.message
        : requiresPreflight && preview.status !== 'success'
          ? '현재 source와 Measurement에 대한 성공한 preflight가 필요합니다.'
          : undefined)
  useEffect(() => {
    const recordName = experimentRecords[0]?.name
    if (!recordName || draft.id !== null || draft.sourceCode !== calculationSourceSkeleton()) return
    const next = emptyCalculationDraft(recordName)
    dispatchEditing({ type: 'templateResolved', draft: next })
  }, [draft.id, draft.sourceCode, experimentRecords])
  const scalarCalculationId =
    dataReadable &&
    draft.id !== null &&
    !dirty &&
    selectedCalculationId === draft.id &&
    preview.status === 'success' &&
    preview.output.shape.length === 0
      ? draft.id
      : null
  const scalarQuery = useQuery({
    ...calculationScalarsQueryOptions(queryScope, experimentId, scalarCalculationId, measurementId),
    enabled: scalarCalculationId !== null,
  })
  const catalogSummaries = useMemo(() => {
    const requiredByPath = new Map(recordedSnapshot.summaries.map((summary) => [summary.path, summary]))
    return summarizeCalculationRecordedData(recordedRules, recordedData).map(
      (summary) => requiredByPath.get(summary.path) ?? summary,
    )
  }, [recordedData, recordedRules, recordedSnapshot.summaries])
  const experimentRecordCatalogItems = useMemo(
    () =>
      buildExperimentRecordCatalogItems(
        experimentRecords,
        dependencyState.error ? null : dependencyState.names,
        measurementId !== null,
        measurementLoading,
        catalogSummaries,
      ),
    [
      catalogSummaries,
      dependencyState.error,
      dependencyState.names,
      experimentRecords,
      measurementId,
      measurementLoading,
    ],
  )
  const agentContext = useMemo(() => {
    const rowIds = new Map(recordedRows.map((row) => [row.name, row.id ?? null]))
    const sampleTicks = (ticks: readonly (number | string)[]) => ({
      count: ticks.length,
      first: ticks.slice(0, 4),
      last: ticks.length > 4 ? ticks.slice(-4) : [],
    })
    const recorded = recordedSnapshot.summaries.map((summary) => {
      const leaf = recordedSnapshot.input?.[summary.path]
      return {
        id: rowIds.get(summary.path) ?? null,
        path: summary.path,
        dtype: leaf?.dtype ?? summary.dtype,
        shape: summary.shape,
        actualAxisLengths: summary.actualAxisLengths,
        axes: (leaf?.axes ?? summary.axes).map((axis) => ({
          name: axis.name,
          unit: axis.unit ?? null,
          ticks: sampleTicks(axis.ticks),
        })),
        quantityKind: summary.quantityKind,
        tensorOrder: leaf?.tensorOrder ?? summary.tensorOrder,
        unit: summary.unit,
        valid: summary.valid,
        error: summary.error,
      }
    })
    const availableExperimentRecords = [...experimentRecordCatalogItems]
      .sort(
        (left, right) =>
          Number(right.used === true) - Number(left.used === true) || left.record.name.localeCompare(right.record.name),
      )
      .map(({ record, status, used }) => ({
        id: record.id,
        name: record.name,
        dtype: record.dtype,
        tensorOrder: record.tensor_order,
        quantityKind: record.quantity_kind,
        dataSchema: record.data_schema ?? null,
        used,
        selectedMeasurementStatus: status,
      }))
    const previewContext =
      preview.status === 'success'
        ? {
            status: preview.status,
            dtype: preview.output.dtype,
            shape: preview.output.shape,
            axes: preview.output.axes.map((axis) => ({
              name: axis.name,
              unit: axis.unit ?? null,
              ticks: sampleTicks(axis.ticks),
            })),
            values:
              typeof preview.output.data === 'number'
                ? { count: 1, first: [preview.output.data], last: [] }
                : {
                    count: preview.output.data.length,
                    first: preview.output.data.slice(0, 16),
                    last: preview.output.data.length > 16 ? preview.output.data.slice(-16) : [],
                  },
          }
        : preview.status === 'error'
          ? { status: preview.status, code: preview.code, message: preview.message }
          : { status: preview.status, message: preview.message }
    const context: Record<string, unknown> = {
      calculation: { dirty, isNew: draft.id === null },
      measurementId,
      experimentRecords: availableExperimentRecords,
      recordedData: recorded,
      preview: previewContext,
    }
    while (
      new TextEncoder().encode(JSON.stringify(context)).byteLength > 32 * 1024 &&
      availableExperimentRecords.length
    ) {
      availableExperimentRecords.pop()
      context.experimentRecordsOmitted = experimentRecordCatalogItems.length - availableExperimentRecords.length
    }
    while (new TextEncoder().encode(JSON.stringify(context)).byteLength > 32 * 1024 && recorded.length) {
      recorded.pop()
      context.recordedDataOmitted = recordedSnapshot.summaries.length - recorded.length
    }
    return Object.freeze(context)
  }, [dirty, draft.id, experimentRecordCatalogItems, measurementId, preview, recordedRows, recordedSnapshot])
  useEffect(() => {
    let active = true
    setAgentIdentity(null)
    void calculationSourceHash(draft.sourceCode).then((hash) => {
      if (active) setAgentIdentity({ sourceCode: draft.sourceCode, hash })
    })
    return () => {
      active = false
    }
  }, [draft.sourceCode])

  const applyAgentSource = useCallback(
    async (request: AiAgentApplyRequest): Promise<AiAgentApplyResult> => {
      const finalDocument = request.finalDocument
      const current = draftRef.current
      if (
        finalDocument.kind !== 'calculation' ||
        finalDocument.experimentId !== experimentId ||
        finalDocument.calculationId !== current.id
      ) {
        return { status: 'conflicted', message: 'Agent Calculation target이 현재 draft와 일치하지 않습니다.' }
      }
      const [currentHash, finalHash] = await Promise.all([
        calculationSourceHash(current.sourceCode),
        calculationSourceHash(finalDocument.sourceCode),
      ])
      if (finalHash !== request.sourceHash) {
        return { status: 'conflicted', message: 'Agent 완료 source의 SHA-256이 일치하지 않습니다.' }
      }
      const changed = {
        runId: request.runId,
        before: current.sourceCode,
        after: finalDocument.sourceCode,
        ...calculationChangedLines(current.sourceCode, finalDocument.sourceCode),
      }
      if (
        !sourceEditableRef.current ||
        calculationDataBusyRef.current ||
        currentHash !== request.baseHash ||
        request.workspaceSession !== calculationWorkspaceSession
      ) {
        dispatchEditing({ type: 'agentStaged', change: { ...changed, status: 'conflicted' } })
        return {
          status: 'conflicted',
          message: 'Calculation source 또는 target이 변경되어 staged diff만 보존했습니다.',
        }
      }
      if (current.sourceCode === finalDocument.sourceCode) return { status: 'applied', changedFiles: 0 }
      invalidatePreview('AI source 변경을 기다리는 중…')
      dispatchEditing({
        type: 'agentApplied',
        sourceCode: finalDocument.sourceCode,
        change: { ...changed, status: 'applied' },
      })
      return { status: 'applied', changedFiles: 1, firstChangedFile: 'calculation.js' }
    },
    [calculationWorkspaceSession, experimentId, invalidatePreview],
  )

  const agentBridge = useMemo<CalculationAgentBridge | null>(() => {
    if (experimentId === null) return null
    return Object.freeze({
      calculationId: draft.id,
      experimentId,
      name: draft.name,
      description: draft.description,
      sourceCode: draft.sourceCode,
      baseHash: agentIdentity?.sourceCode === draft.sourceCode ? agentIdentity.hash : null,
      context: agentContext,
      editable: sourceEditable && !calculationDataBusy,
      targetLabel: draft.id === null ? 'Calculation New' : `Calculation #${draft.id}`,
      workspaceSession: calculationWorkspaceSession,
      apply: applyAgentSource,
    })
  }, [
    agentContext,
    agentIdentity,
    applyAgentSource,
    calculationDataBusy,
    calculationWorkspaceSession,
    draft,
    sourceEditable,
    experimentId,
  ])

  useEffect(() => onAgentBridgeChange(agentBridge), [agentBridge, onAgentBridgeChange])
  useEffect(() => () => onAgentBridgeChange(null), [onAgentBridgeChange])

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  useEffect(
    () => onSaveStateChange({ disabled: saveDisabledReason !== undefined, disabledReason: saveDisabledReason }),
    [onSaveStateChange, saveDisabledReason],
  )

  useEffect(() => {
    if (appliedExperimentRef.current === experimentId) return
    appliedExperimentRef.current = experimentId
    mutationSequenceRef.current += 1
    setSaving(false)
    setDeleting(false)
    setSaveDialogOpen(false)
    dispatchEditing({ type: 'experimentChanged', recordName: experimentRecords[0]?.name })
  }, [experimentId, experimentRecords])

  useEffect(() => {
    if (selectedCalculationRef.current === selectedCalculationId) return
    selectedCalculationRef.current = selectedCalculationId
    mutationSequenceRef.current += 1
    setSaving(false)
    setDeleting(false)
    setSaveDialogOpen(false)
    dispatchEditing({
      type: 'selectionChanged',
      calculationId: selectedCalculationId,
      recordName: experimentRecords[0]?.name,
    })
  }, [experimentRecords, selectedCalculationId])

  useEffect(() => {
    if (selectedCalculationId === null) return
    const row = rows.find((candidate) => candidate.id === selectedCalculationId)
    if (!row) return
    dispatchEditing({ type: 'serverSnapshotReceived', record: row })
  }, [rows, selectedCalculationId])

  useEffect(() => {
    if (
      selectedCalculationId === null ||
      contextPending ||
      !calculationsQuery.isSuccess ||
      calculationsQuery.isFetching ||
      rows.some((row) => row.id === selectedCalculationId)
    ) {
      return
    }
    dispatchEditing({ type: 'serverSnapshotMissing', recordName: experimentRecords[0]?.name })
    if (dirty || agentChange !== null) return
    selectedCalculationRef.current = null
    onCalculationIdChange(null)
    toast.error('선택한 Calculation이 없거나 현재 Experiment에 속하지 않습니다.')
  }, [
    calculationsQuery.isFetching,
    calculationsQuery.isSuccess,
    agentChange,
    contextPending,
    dirty,
    experimentRecords,
    onCalculationIdChange,
    rows,
    selectedCalculationId,
  ])

  const replaceDraft = useCallback(
    (next: CalculationDraft, nextId: number | null, serverSnapshot: SavedCalculation | null = null) => {
      if (saving || deleting) return false
      if (dirty && !window.confirm('저장하지 않은 Calculation 편집을 버리고 선택을 바꿀까요?')) return false
      setSaveDialogOpen(false)
      invalidatePreview('Calculation source를 바꾸는 중…')
      dispatchEditing({ type: 'draftReplaced', draft: next, serverSnapshot })
      onCalculationIdChange(nextId)
      return true
    },
    [deleting, dirty, invalidatePreview, onCalculationIdChange, saving],
  )

  useEffect(() => {
    if (
      experimentId === null ||
      contextPending ||
      measurementLoading ||
      measurementSelectionPending ||
      defaultMeasurementExperimentRef.current === experimentId
    ) {
      return
    }
    if (measurementId !== null) {
      defaultMeasurementExperimentRef.current = experimentId
      return
    }
    if (!defaultMeasurementQuery.isSuccess || defaultMeasurementQuery.isFetching) return
    defaultMeasurementExperimentRef.current = experimentId
    if (!defaultMeasurement) return
    invalidatePreview('Measurement RecordedData를 불러오는 중…')
    onSelectMeasurement(defaultMeasurement)
  }, [
    contextPending,
    defaultMeasurement,
    defaultMeasurementQuery.isFetching,
    defaultMeasurementQuery.isSuccess,
    experimentId,
    invalidatePreview,
    measurementId,
    measurementLoading,
    measurementSelectionPending,
    onSelectMeasurement,
  ])

  useEffect(() => {
    if (experimentId === null || contextPending || defaultCalculationExperimentRef.current === experimentId) {
      return
    }
    if (selectedCalculationId !== null) {
      defaultCalculationExperimentRef.current = experimentId
      return
    }
    if (!calculationsQuery.isSuccess || calculationsQuery.isFetching) return
    defaultCalculationExperimentRef.current = experimentId
    if (!rows[0]) return
    replaceDraft(calculationDraftFromRecord(rows[0]), rows[0].id, rows[0])
  }, [
    calculationsQuery.isFetching,
    calculationsQuery.isSuccess,
    contextPending,
    experimentId,
    replaceDraft,
    rows,
    selectedCalculationId,
  ])

  const save = useCallback(
    async (values?: CalculationSaveValues) => {
      if (!authenticated || !persistable) {
        toast.error(
          demoSandbox
            ? '공개 Demo Calculation은 저장할 수 없습니다. 로컬 미리보기만 사용할 수 있습니다.'
            : '이 Experiment의 Calculation을 저장할 권한이 없습니다.',
        )
        return false
      }
      if (!experimentId) {
        toast.error('먼저 저장된 Experiment를 여세요.')
        return false
      }
      const name = (values?.name ?? draft.name).trim()
      if (!name) {
        toast.error('Calculation 이름을 입력하세요.')
        return false
      }
      if (saving || deleting) return false
      const description = (values?.description ?? draft.description).trim()
      const sequence = ++mutationSequenceRef.current
      setSaving(true)
      try {
        if (dependencyState.error) throw dependencyState.error
        const sourceHash = await calculationSourceHash(draft.sourceCode)
        let outputLayout: CalculationOutputLayout | null = selectedRow?.output_layout ?? null
        let preflightMeasurementId = selectedRow?.preflight_measurement_id ?? null
        let experimentRecordIds = [...(selectedRow?.experiment_record_ids ?? [])]
        if (requiresPreflight) {
          if (preview.status !== 'success' || measurementId === null) {
            throw new Error('현재 source와 선택한 Measurement에 대한 성공한 preflight가 필요합니다.')
          }
          outputLayout = Object.freeze({
            dtype: preview.output.dtype,
            shape: Object.freeze([...preview.output.shape]),
            axes: Object.freeze(
              preview.output.axes.map((axis) =>
                Object.freeze({
                  name: axis.name,
                  ticks: Object.freeze([...axis.ticks]),
                  ...(axis.unit === undefined ? {} : { unit: axis.unit }),
                }),
              ),
            ),
          })
          preflightMeasurementId = measurementId
          const recordsByName = new Map(experimentRecords.map((record) => [record.name, record.id]))
          experimentRecordIds = dependencyState.names.map((name) => {
            const recordId = recordsByName.get(name)
            if (recordId === undefined) throw new Error(`ExperimentRecord를 찾을 수 없습니다: ${name}`)
            return recordId
          })
        }
        if (!outputLayout || preflightMeasurementId === null) {
          throw new Error('저장된 Calculation preflight 계약이 없습니다.')
        }
        const [result] = await dbTables.Calculation.upsertRow([
          {
            ...(draft.id === null ? {} : { id: draft.id }),
            description: description || null,
            experiment_id: experimentId,
            name,
            source_code: draft.sourceCode,
            source_hash: sourceHash,
            output_layout: outputLayout,
            preflight_measurement_id: preflightMeasurementId,
            contract_status: 'ready',
            experiment_record_ids: experimentRecordIds,
          },
        ])
        if (sequence !== mutationSequenceRef.current) {
          await invalidateCalculationMutation(queryClient, queryScope, experimentId)
          return false
        }
        const next = { ...draft, description, id: result.id, name }
        dispatchEditing({ type: 'saveCommitted', draft: next })
        selectedCalculationRef.current = result.id
        onCalculationIdChange(result.id)
        await invalidateCalculationMutation(queryClient, queryScope, experimentId)
        await onUsageChanged().catch((cause: unknown) => {
          toast.error(
            `Calculation은 저장했지만 Experiment 사용량을 갱신하지 못했습니다: ${cause instanceof Error ? cause.message : String(cause)}`,
          )
        })
        toast.success('Calculation을 저장했습니다.')
        return true
      } catch (cause: unknown) {
        if (sequence === mutationSequenceRef.current) {
          toast.error(cause instanceof Error ? cause.message : String(cause))
        }
        return false
      } finally {
        if (sequence === mutationSequenceRef.current) setSaving(false)
      }
    },
    [
      authenticated,
      deleting,
      draft,
      dependencyState.error,
      dependencyState.names,
      demoSandbox,
      experimentId,
      experimentRecords,
      measurementId,
      onCalculationIdChange,
      onUsageChanged,
      persistable,
      queryClient,
      queryScope,
      preview,
      requiresPreflight,
      selectedRow,
      saving,
    ],
  )

  const openSaveDialog = useCallback(() => {
    if (!authenticated) {
      onRequestLogin()
      return
    }
    if (saveDisabledReason) {
      toast.error(saveDisabledReason)
      return
    }
    setSaveDialogOpen(true)
  }, [authenticated, onRequestLogin, saveDisabledReason])

  const saveFromShortcut = useCallback(() => {
    if (!authenticated) {
      onRequestLogin()
      return
    }
    if (saveDisabledReason) {
      toast.error(saveDisabledReason)
      return
    }
    if (draft.id === null) openSaveDialog()
    else void save()
  }, [authenticated, draft.id, onRequestLogin, openSaveDialog, save, saveDisabledReason])

  useEffect(() => {
    if (appliedSaveCommandRef.current === saveCommand) return
    appliedSaveCommandRef.current = saveCommand
    if (saveCommand > 0) openSaveDialog()
  }, [openSaveDialog, saveCommand])

  useEffect(() => {
    if (contextPending) setSaveDialogOpen(false)
  }, [contextPending])

  useEffect(
    () => () => onSaveStateChange({ disabled: true, disabledReason: 'Calculation Editor를 불러오는 중입니다.' }),
    [onSaveStateChange],
  )

  const deleteCurrent = async () => {
    if (saving || deleting) return
    if (draft.id === null) {
      if (!sourceEditable) return
      if (dirty && !window.confirm('저장하지 않은 새 Calculation draft를 버릴까요?')) return
      dispatchEditing({ type: 'newStarted', recordName: experimentRecords[0]?.name })
      setSaveDialogOpen(false)
      return
    }
    if (!persistable) return
    if (
      !window.confirm(
        `${draft.name || `Calculation #${draft.id}`}을 영구 삭제할까요?${dirty ? '\n저장하지 않은 편집도 함께 사라집니다.' : ''}${publicDemoMutable ? '\n공개 Demo 데이터에 즉시 반영되며 Prediction이 Not Ready가 될 수 있습니다.' : ''}`,
      )
    ) {
      return
    }
    const sequence = ++mutationSequenceRef.current
    setDeleting(true)
    try {
      await dbTables.Calculation.deleteRows([draft.id])
      if (sequence !== mutationSequenceRef.current) {
        await invalidateCalculationMutation(queryClient, queryScope, experimentId)
        return
      }
      dispatchEditing({ type: 'deleted', recordName: experimentRecords[0]?.name })
      setSaveDialogOpen(false)
      selectedCalculationRef.current = null
      onCalculationIdChange(null)
      await invalidateCalculationMutation(queryClient, queryScope, experimentId)
      await onUsageChanged().catch((cause: unknown) => {
        toast.error(
          `Calculation은 삭제했지만 Experiment 사용량을 갱신하지 못했습니다: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      })
      toast.success('Calculation을 삭제했습니다.')
    } catch (cause: unknown) {
      if (sequence === mutationSequenceRef.current) {
        toast.error(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (sequence === mutationSequenceRef.current) setDeleting(false)
    }
  }

  const editorKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== 's') return
    if (event.target instanceof Element && event.target.closest('.monaco-editor')) return
    event.preventDefault()
    saveFromShortcut()
  }

  const undoAgentChange = () => {
    if (!agentChange || agentChange.status !== 'applied') return
    if (draftRef.current.sourceCode !== agentChange.after) {
      toast.error('AI 적용 후 source가 다시 변경되어 자동 Undo할 수 없습니다. Diff에서 확인하세요.')
      dispatchEditing({ type: 'agentDiffOpenChanged', open: true })
      return
    }
    invalidatePreview('AI source 변경을 되돌리는 중…')
    dispatchEditing({ type: 'agentUndoApplied' })
  }

  const sourceEditorDisabled =
    !sourceEditable || saving || deleting || calculationDataBusy || contextPending || selectedCalculationId !== draft.id
  const insertDisabledReason = !sourceEditable
    ? '이 Experiment의 Calculation source를 편집할 권한이 없습니다.'
    : saving
      ? 'Calculation 저장이 진행 중입니다.'
      : deleting
        ? 'Calculation 삭제가 진행 중입니다.'
        : calculationDataBusy
          ? 'CalculationData 작업이 진행 중입니다.'
          : contextPending || selectedCalculationId !== draft.id
            ? 'Calculation context를 불러오는 중입니다.'
            : agentChange && agentDiffOpen
              ? 'AI diff를 닫은 뒤 Source Editor에 삽입하세요.'
              : inputBindingState.error
                ? inputBindingState.error
                : null
  const insertExperimentRecord = (recordName: string) => {
    if (insertDisabledReason) return
    try {
      const reference = calculationExperimentRecordReference(draft.sourceCode, recordName)
      if (!sourceEditorRef.current?.insertAtSelection(reference)) {
        toast.error('Source Editor가 준비되지 않았습니다. 잠시 후 다시 시도하세요.')
      }
    } catch (cause: unknown) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="shrink-0">
        {menubar}
        {ribbon}
      </header>
      <ResizableCalculationLayout
        bottom={bottom}
        bottomHeightRatio={bottomHeightRatio}
        bottomMode={bottomMode}
        calculationList={
          <section className="flex h-full min-h-0 flex-col gap-2 p-2" aria-label="Calculation 목록">
            <header className="flex shrink-0 items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Calculations</h2>
              <div className="flex gap-1">
                <Button
                  aria-label="새 Calculation"
                  disabled={!sourceEditable || experimentId === null || saving || deleting || calculationDataBusy}
                  size="icon"
                  title="New"
                  type="button"
                  variant="outline"
                  onClick={() => {
                    defaultCalculationExperimentRef.current = experimentId
                    replaceDraft(emptyCalculationDraft(experimentRecords[0]?.name), null)
                  }}
                >
                  <FilePlus2 />
                </Button>
                <Button
                  aria-label="선택한 Calculation 삭제"
                  disabled={
                    saving ||
                    deleting ||
                    calculationDataBusy ||
                    (draft.id === null ? !sourceEditable || !dirty : !persistable)
                  }
                  size="icon"
                  title="Delete"
                  type="button"
                  variant="outline"
                  onClick={() => void deleteCurrent()}
                >
                  {deleting ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
                </Button>
              </div>
            </header>
            <div className="min-h-0 flex-1 overflow-auto rounded border">
              {experimentId === null ? (
                <div className="grid h-full min-h-24 place-items-center p-3 text-center text-xs text-muted-foreground">
                  먼저 저장된 Experiment를 여세요.
                </div>
              ) : calculationsQuery.isLoading ? (
                <div className="grid h-full min-h-24 place-items-center text-xs text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" />
                </div>
              ) : calculationsQuery.isError ? (
                <div className="grid h-full min-h-24 place-items-center p-3 text-center text-xs text-destructive">
                  Calculation 목록을 불러오지 못했습니다.
                </div>
              ) : rows.length ? (
                <ul className="divide-y">
                  {rows.map((row) => (
                    <li key={row.id}>
                      <button
                        aria-current={draft.id === row.id ? 'true' : undefined}
                        className={cn(
                          'w-full px-3 py-2 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                          draft.id === row.id && 'bg-accent',
                        )}
                        disabled={saving || deleting || calculationDataBusy}
                        type="button"
                        onClick={() => replaceDraft(calculationDraftFromRecord(row), row.id, row)}
                      >
                        <span className="block truncate font-medium text-foreground">{row.name}</span>
                        <span className="mt-0.5 block truncate text-muted-foreground">
                          {row.description || `Calculation #${row.id}`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="grid h-full min-h-24 place-items-center p-3 text-center text-xs text-muted-foreground">
                  저장된 Calculation이 없습니다.
                </div>
              )}
            </div>
          </section>
        }
        columnRatios={columnRatios}
        editor={
          <section className="flex h-full min-h-0 flex-col" onKeyDown={editorKeyDown}>
            {demoSandbox ? (
              <div className="shrink-0 border-b bg-sky-50 px-3 py-1.5 text-xs text-sky-950">
                Demo 원본과 저장 데이터는 읽기 전용입니다. 이 source 변경은 로컬 Preview에만 적용됩니다.
              </div>
            ) : null}
            {agentChange ? (
              <div className="flex shrink-0 items-center justify-between gap-2 border-b bg-amber-50 px-3 py-1.5 text-xs text-amber-950">
                <span className="flex min-w-0 items-center gap-2">
                  <Sparkles className="size-3.5 shrink-0" />
                  <strong>{agentChange.status === 'applied' ? 'AI 미검증' : 'AI staged'}</strong>
                  <span className="text-amber-800">
                    +{agentChange.addedLines} / -{agentChange.removedLines} lines
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    type="button"
                    variant="outline"
                    onClick={() => dispatchEditing({ type: 'agentDiffOpenChanged', open: !agentDiffOpen })}
                  >
                    JavaScript Diff
                  </Button>
                  {agentChange.status === 'applied' ? (
                    <Button size="sm" type="button" variant="outline" onClick={undoAgentChange}>
                      <RotateCcw /> Undo
                    </Button>
                  ) : null}
                  <Button
                    aria-label="AI 변경 상태 닫기"
                    size="icon"
                    type="button"
                    variant="ghost"
                    onClick={() => dispatchEditing({ type: 'agentChangeDismissed' })}
                  >
                    <X />
                  </Button>
                </span>
              </div>
            ) : null}
            <div className="min-h-0 flex-1">
              {agentChange && agentDiffOpen ? (
                <CadDiffEditor
                  changeId={agentChange.runId}
                  language="javascript"
                  modelPath="file:///calculation-agent-diff.js"
                  modified={agentChange.after}
                  original={agentChange.before}
                  readOnly
                  onChange={() => undefined}
                />
              ) : (
                <CalculationSourceEditor
                  ref={sourceEditorRef}
                  diagnostic={preview.status === 'error' && preview.code === 'policy' ? preview.diagnostic : undefined}
                  disabled={sourceEditorDisabled}
                  sourceCode={draft.sourceCode}
                  onSave={saveFromShortcut}
                  onSourceCodeChange={(sourceCode) => {
                    invalidatePreview('Source 변경을 기다리는 중…')
                    dispatchEditing({ type: 'sourceEdited', sourceCode })
                  }}
                />
              )}
            </div>
          </section>
        }
        measurementExplorer={
          <section className="flex h-full min-h-0 flex-col p-2">
            <Tabs
              className="flex min-h-0 flex-1 flex-col"
              value={inputPanel}
              onValueChange={(value) => setInputPanel(value as 'measurements' | 'vars')}
            >
              <TabsList aria-label="Candidate 입력 패널" className="mb-2 h-8 shrink-0 self-start">
                <TabsTrigger className="h-6 px-2 text-xs" value="measurements">
                  Measurements
                </TabsTrigger>
                <TabsTrigger className="h-6 px-2 text-xs" value="vars">
                  Vars
                </TabsTrigger>
              </TabsList>
              {inputPanel === 'measurements' ? (
                <MeasurementExplorer
                  busy={busy}
                  calculationTotal={
                    calculationsQuery.isError
                      ? 'error'
                      : calculationsQuery.isFetching || !calculationsQuery.isSuccess
                        ? 'loading'
                        : rows.length
                  }
                  className="min-h-0 gap-2"
                  enabled={dataReadable}
                  experimentId={experimentId}
                  selectedId={measurementId}
                  onClearSelection={() => {
                    invalidatePreview('Measurement 선택을 해제하는 중…')
                    onClearMeasurement()
                  }}
                  onDelete={persistable ? onDeleteMeasurements : undefined}
                  publicDataWarning={publicDemoMutable}
                  onSelect={(row) => {
                    invalidatePreview('Measurement RecordedData를 불러오는 중…')
                    onSelectMeasurement(row)
                  }}
                />
              ) : (
                <VarsPanel
                  candidateSessionKey={candidateSessionKey}
                  disabled={candidateEditingDisabled}
                  resetValues={candidateResetValues}
                  schema={varsSchema}
                  vars={candidateVars}
                  onVariableChange={onCandidateVariableChange}
                />
              )}
            </Tabs>
          </section>
        }
        onColumnRatiosChange={(ratios) => onColumnRatiosChange(ratios as readonly [number, number, number, number])}
        onBottomHeightRatioChange={onBottomHeightRatioChange}
        onRowRatiosChange={(ratios) => onRowRatiosChange(ratios as readonly [number, number, number])}
        output={
          <section className="flex h-full min-h-0 flex-col">
            <header className="shrink-0 border-b px-3 py-2">
              <h2 className="text-sm font-semibold">Output Chart</h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Preview와 저장된 Measurement별 CalculationData를 비교합니다.
              </p>
            </header>
            <div className="min-h-0 flex-1 overflow-hidden">
              <ResizableCalculationOutput
                chartRatio={outputChartRatio}
                comparisonMessage={
                  draft.id === null
                    ? demoSandbox
                      ? '새 로컬 Draft는 Preview만 표시하며 Demo에 저장되지 않습니다.'
                      : 'Calculation을 저장하면 다른 Measurement와 비교할 수 있습니다.'
                    : dirty
                      ? demoSandbox
                        ? '로컬 수정 중에는 Preview만 표시합니다. 저장된 비교 데이터는 원본 source 기준입니다.'
                        : '수정한 Calculation을 저장한 뒤 비교 데이터를 다시 계산하세요.'
                      : scalarQuery.isFetching
                        ? '저장된 비교 데이터를 불러오는 중…'
                        : scalarQuery.isError
                          ? '저장된 비교 데이터를 불러오지 못했습니다.'
                          : undefined
                }
                measurementId={measurementId}
                preview={preview}
                scalarValues={scalarQuery.isFetching ? undefined : scalarQuery.data?.items.map((item) => item.value)}
                onChartRatioChange={onOutputChartRatioChange}
              />
            </div>
          </section>
        }
        recordedDataSummary={
          <ExperimentRecordCatalog
            analysisError={dependencyState.error?.message ?? null}
            experimentId={experimentId}
            insertDisabledReason={insertDisabledReason}
            items={experimentRecordCatalogItems}
            loading={experimentRecordsQuery.isLoading}
            loadError={experimentRecordsQuery.isError}
            onInsert={insertExperimentRecord}
          />
        }
        rowRatios={rowRatios}
        viewer={viewer}
        viewerExpanded={viewerExpanded}
      />
      <CalculationSaveDialog
        defaults={{ description: draft.description, name: draft.name }}
        isNew={draft.id === null}
        open={saveDialogOpen}
        pending={saving}
        onOpenChange={setSaveDialogOpen}
        onSubmit={async (values) => {
          if (await save(values)) setSaveDialogOpen(false)
        }}
      />
    </div>
  )
}
