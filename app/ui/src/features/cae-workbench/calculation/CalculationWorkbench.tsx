import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FilePlus2, LoaderCircle, RotateCcw, Sparkles, Trash2, X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'
import { dbTables, getListRequest, type CalculationRecord } from '@/api'
import type { AiAgentApplyRequest, AiAgentApplyResult } from '@/api/aiAgent'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MeasurementExplorer } from '@/features/cae-workbench/measurement'
import type { BottomDockMode, SavedMeasurement, SavedRecordedData } from '@/features/cae-workbench/types'
import { CadDiffEditor } from '@/features/viewer/editor/CadDiffEditor'
import {
  CALCULATION_SOURCE_SKELETON,
  CalculationExecutionError,
  calculationSourceHash,
  runCalculation,
  type CalculationInput,
} from '@/lib/calculation'
import type { RecordedData, RecordedDataRule, Tensor, Vars, VarsSchemaEntry } from '@/lib/cad'
import { cn } from '@/lib/utils'
import { buildCalculationRecordedData } from './calculationRecordedData'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { type CalculationPreviewState } from './CalculationOutputChart'
import { ResizableCalculationOutput } from './ResizableCalculationOutput'
import { CalculationSaveDialog, type CalculationSaveValues } from './CalculationSaveDialog'
import { CalculationSourceEditor } from './CalculationSourceEditor'
import { ResizableCalculationLayout } from './ResizableCalculationLayout'
import { VarsPanel } from './VarsPanel'

type SavedCalculation = CalculationRecord & { id: number }
type CalculationDraft = Readonly<{
  id: number | null
  name: string
  description: string
  sourceCode: string
}>

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

type CalculationAgentChange = Readonly<{
  runId: string
  status: 'applied' | 'conflicted'
  before: string
  after: string
  addedLines: number
  removedLines: number
}>

function emptyCalculationDraft(): CalculationDraft {
  return { id: null, description: '', name: '', sourceCode: CALCULATION_SOURCE_SKELETON }
}

function calculationDraft(row: SavedCalculation): CalculationDraft {
  return {
    id: row.id,
    description: row.description ?? '',
    name: row.name,
    sourceCode: row.source_code,
  }
}

function sameDraft(left: CalculationDraft, right: CalculationDraft) {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.description === right.description &&
    left.sourceCode === right.sourceCode
  )
}

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

export function CalculationWorkbench({
  authenticated,
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
  editable,
  experimentId,
  measurementId,
  measurementLoading,
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
  onRowRatiosChange,
  onSaveStateChange,
  onUsageChanged,
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
}: {
  authenticated: boolean
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
  editable: boolean
  experimentId: number | null
  measurementId: number | null
  measurementLoading: boolean
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
  onRowRatiosChange: (ratios: readonly [number, number, number]) => void
  onSaveStateChange: (state: CalculationSaveState) => void
  onUsageChanged: () => Promise<void>
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
}) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<CalculationDraft>(emptyCalculationDraft)
  const [baseline, setBaseline] = useState<CalculationDraft>(emptyCalculationDraft)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [preview, setPreview] = useState<CalculationPreviewState>({
    status: 'idle',
    message: 'Recorded Measurement와 Calculation source를 선택하세요.',
  })
  const [agentIdentity, setAgentIdentity] = useState<Readonly<{ sourceCode: string; hash: string }> | null>(null)
  const [agentChange, setAgentChange] = useState<CalculationAgentChange | null>(null)
  const [agentDiffOpen, setAgentDiffOpen] = useState(false)
  const [inputPanel, setInputPanel] = useState<'measurements' | 'vars'>('measurements')
  const [agentTargetSession, setAgentTargetSession] = useState(0)
  const draftRef = useRef(draft)
  const editableRef = useRef(editable)
  const calculationDataBusyRef = useRef(calculationDataBusy)
  draftRef.current = draft
  editableRef.current = editable
  calculationDataBusyRef.current = calculationDataBusy
  const appliedExperimentRef = useRef(experimentId)
  const selectedCalculationRef = useRef(selectedCalculationId)
  const mutationSequenceRef = useRef(0)
  const appliedSaveCommandRef = useRef(saveCommand)
  const previewSequenceRef = useRef(0)
  const previewAbortRef = useRef<AbortController | null>(null)
  const dirty = !sameDraft(draft, baseline)
  const calculationWorkspaceSession = agentWorkspaceSession * 1_000_000 + agentTargetSession
  const saveDisabledReason = !authenticated
    ? '로그인 후 사용할 수 있습니다.'
    : experimentId === null
      ? '먼저 저장된 Experiment를 여세요.'
      : !editable
        ? '이 Experiment의 Calculation을 저장할 권한이 없습니다.'
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
    enabled: authenticated && experimentId !== null,
    queryFn: () => dbTables.Calculation.listRows(request),
    queryKey: ['cae-workbench', 'calculations', request],
  })
  const rows = useMemo(
    () => (calculationsQuery.data?.items ?? []).filter((row): row is SavedCalculation => typeof row.id === 'number'),
    [calculationsQuery.data?.items],
  )
  const scalarCalculationId =
    authenticated &&
    draft.id !== null &&
    !dirty &&
    selectedCalculationId === draft.id &&
    preview.status === 'success' &&
    preview.output.shape.length === 0
      ? draft.id
      : null
  const scalarQuery = useQuery({
    enabled: scalarCalculationId !== null,
    queryKey: ['cae-workbench', 'calculation-data', 'scalars', scalarCalculationId, measurementId],
    queryFn: () => {
      if (scalarCalculationId === null) throw new Error('Scalar Calculation이 선택되지 않았습니다.')
      return dbTables.CalculationData.scalars({
        calculation_id: scalarCalculationId,
        ...(measurementId === null ? {} : { exclude_measurement_id: measurementId }),
      })
    },
  })
  const recordedSnapshot = useMemo(
    () => buildCalculationRecordedData(recordedRules, recordedData),
    [recordedData, recordedRules],
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
      recordedData: recorded,
      preview: previewContext,
    }
    while (new TextEncoder().encode(JSON.stringify(context)).byteLength > 32 * 1024 && recorded.length) {
      recorded.pop()
      context.recordedDataOmitted = recordedSnapshot.summaries.length - recorded.length
    }
    return Object.freeze(context)
  }, [dirty, draft.id, measurementId, preview, recordedRows, recordedSnapshot])
  const invalidatePreview = useCallback((message: string) => {
    previewSequenceRef.current += 1
    previewAbortRef.current?.abort()
    setPreview({ status: 'loading', message })
  }, [])

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
        !editableRef.current ||
        calculationDataBusyRef.current ||
        currentHash !== request.baseHash ||
        request.workspaceSession !== calculationWorkspaceSession
      ) {
        setAgentChange({ ...changed, status: 'conflicted' })
        setAgentDiffOpen(true)
        return {
          status: 'conflicted',
          message: 'Calculation source 또는 target이 변경되어 staged diff만 보존했습니다.',
        }
      }
      if (current.sourceCode === finalDocument.sourceCode) return { status: 'applied', changedFiles: 0 }
      invalidatePreview('AI source 변경을 기다리는 중…')
      setDraft((value) => ({ ...value, sourceCode: finalDocument.sourceCode }))
      setAgentChange({ ...changed, status: 'applied' })
      setAgentDiffOpen(false)
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
      editable: editable && !calculationDataBusy,
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
    editable,
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
    setAgentChange(null)
    setAgentDiffOpen(false)
    setAgentTargetSession((value) => value + 1)
    const next = emptyCalculationDraft()
    setDraft(next)
    setBaseline(next)
  }, [experimentId])

  useEffect(() => {
    if (selectedCalculationRef.current === selectedCalculationId) return
    selectedCalculationRef.current = selectedCalculationId
    mutationSequenceRef.current += 1
    setSaving(false)
    setDeleting(false)
    setSaveDialogOpen(false)
    setAgentChange(null)
    setAgentDiffOpen(false)
    setAgentTargetSession((value) => value + 1)
    if (selectedCalculationId !== null) return
    const next = emptyCalculationDraft()
    setDraft(next)
    setBaseline(next)
  }, [selectedCalculationId])

  useEffect(() => {
    if (selectedCalculationId === null) return
    const row = rows.find((candidate) => candidate.id === selectedCalculationId)
    if (!row || draft.id === row.id) return
    const next = calculationDraft(row)
    setDraft(next)
    setBaseline(next)
  }, [draft.id, rows, selectedCalculationId])

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
    const next = emptyCalculationDraft()
    setDraft(next)
    setBaseline(next)
    selectedCalculationRef.current = null
    onCalculationIdChange(null)
    toast.error('선택한 Calculation이 없거나 현재 Experiment에 속하지 않습니다.')
  }, [
    calculationsQuery.isFetching,
    calculationsQuery.isSuccess,
    contextPending,
    onCalculationIdChange,
    rows,
    selectedCalculationId,
  ])

  useLayoutEffect(() => {
    const sequence = ++previewSequenceRef.current
    const controller = new AbortController()
    previewAbortRef.current = controller
    const cancel = () => {
      controller.abort()
      if (previewAbortRef.current === controller) previewAbortRef.current = null
    }
    if (contextPending) {
      setPreview({ status: 'loading', message: 'Calculation context를 바꾸는 중…' })
      return cancel
    }
    if (selectedCalculationId !== draft.id) {
      setPreview({ status: 'loading', message: 'Calculation source를 불러오는 중…' })
      return cancel
    }
    if (measurementLoading) {
      setPreview({ status: 'loading', message: 'Measurement RecordedData를 불러오는 중…' })
      return cancel
    }
    if (calculationDataBusy) {
      setPreview({ status: 'loading', message: 'CalculationData 일괄 계산이 진행 중…' })
      return cancel
    }
    if (measurementId === null) {
      setPreview({ status: 'idle', message: 'Recorded Measurement를 선택하면 Output을 자동 계산합니다.' })
      return cancel
    }
    if (!recordedSnapshot.input) {
      onActivity({
        source: 'calculation',
        level: 'error',
        phase: recordedSnapshot.errorCode ?? 'input',
        message: recordedSnapshot.error ?? 'RecordedData 입력을 만들지 못했습니다.',
      })
      setPreview({
        code: recordedSnapshot.errorCode ?? 'input',
        message: recordedSnapshot.error ?? 'RecordedData 입력을 만들지 못했습니다.',
        status: 'error',
      })
      return cancel
    }
    setPreview({ status: 'loading', message: 'Source 변경을 기다리는 중…' })
    const timeout = window.setTimeout(() => {
      if (sequence !== previewSequenceRef.current) return
      setPreview({ status: 'loading', message: '격리된 Worker에서 계산 중…' })
      void runCalculation({
        input: recordedSnapshot.input as CalculationInput,
        onLog: (entry) => {
          if (sequence !== previewSequenceRef.current || controller.signal.aborted) return
          onActivity({
            source: 'calculation',
            level: 'info',
            phase: 'console.log',
            message: entry.message,
            runId: entry.requestId,
          })
        },
        signal: controller.signal,
        sourceCode: draft.sourceCode,
      })
        .then((output) => {
          if (sequence === previewSequenceRef.current && !controller.signal.aborted) {
            setPreview({ output, status: 'success' })
          }
        })
        .catch((cause: unknown) => {
          if (sequence !== previewSequenceRef.current || controller.signal.aborted) return
          const error =
            cause instanceof CalculationExecutionError
              ? { code: cause.code, diagnostic: cause.diagnostic, message: cause.message }
              : {
                  code: 'runtime' as const,
                  diagnostic: undefined,
                  message: cause instanceof Error ? cause.message : String(cause),
                }
          if (error.code === 'cancelled') return
          const activityMessage = error.diagnostic
            ? [
                `calculation.js:${error.diagnostic.range.startLineNumber}:${error.diagnostic.range.startColumn} ${error.message}`,
                error.diagnostic.sourceLine,
                `${' '.repeat(Math.max(0, error.diagnostic.range.startColumn - 1))}${'^'.repeat(
                  Math.max(1, error.diagnostic.range.endColumn - error.diagnostic.range.startColumn),
                )}`,
              ].join('\n')
            : error.message
          onActivity({
            source: 'calculation',
            level: 'error',
            phase: error.code,
            message: activityMessage,
          })
          setPreview({ ...error, status: 'error' })
        })
    }, 500)
    return () => {
      window.clearTimeout(timeout)
      cancel()
    }
  }, [
    contextPending,
    calculationDataBusy,
    draft.sourceCode,
    experimentId,
    measurementId,
    measurementLoading,
    onActivity,
    recordedSnapshot,
    selectedCalculationId,
  ])

  const replaceDraft = useCallback(
    (next: CalculationDraft, nextId: number | null) => {
      if (saving || deleting) return false
      if (dirty && !window.confirm('저장하지 않은 Calculation 편집을 버리고 선택을 바꿀까요?')) return false
      setSaveDialogOpen(false)
      setAgentChange(null)
      setAgentDiffOpen(false)
      setAgentTargetSession((value) => value + 1)
      invalidatePreview('Calculation source를 바꾸는 중…')
      setDraft(next)
      setBaseline(next)
      onCalculationIdChange(nextId)
      return true
    },
    [deleting, dirty, invalidatePreview, onCalculationIdChange, saving],
  )

  const save = useCallback(
    async (values?: CalculationSaveValues) => {
      if (!authenticated || !editable) {
        toast.error('이 Experiment의 Calculation을 저장할 권한이 없습니다.')
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
        const [result] = await dbTables.Calculation.upsertRow([
          {
            ...(draft.id === null ? {} : { id: draft.id }),
            description: description || null,
            experiment_id: experimentId,
            name,
            source_code: draft.sourceCode,
          },
        ])
        if (sequence !== mutationSequenceRef.current) {
          await queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'calculations'] })
          await queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'calculation-data'] })
          await queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'measurements'] })
          await queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'experiments'] })
          return false
        }
        const next = { ...draft, description, id: result.id, name }
        setDraft(next)
        setBaseline(next)
        setAgentChange(null)
        setAgentDiffOpen(false)
        setAgentTargetSession((value) => value + 1)
        selectedCalculationRef.current = result.id
        onCalculationIdChange(result.id)
        await queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'calculations'] })
        await queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'calculation-data'] })
        await queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'measurements'] })
        await queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'experiments'] })
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
      editable,
      experimentId,
      onCalculationIdChange,
      onUsageChanged,
      queryClient,
      saving,
    ],
  )

  const openSaveDialog = useCallback(() => {
    if (saveDisabledReason) {
      toast.error(saveDisabledReason)
      return
    }
    setSaveDialogOpen(true)
  }, [saveDisabledReason])

  const saveFromShortcut = useCallback(() => {
    if (saveDisabledReason) {
      toast.error(saveDisabledReason)
      return
    }
    if (draft.id === null) openSaveDialog()
    else void save()
  }, [draft.id, openSaveDialog, save, saveDisabledReason])

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
    if (saving || deleting || !editable) return
    if (draft.id === null) {
      if (dirty && !window.confirm('저장하지 않은 새 Calculation draft를 버릴까요?')) return
      const next = emptyCalculationDraft()
      setDraft(next)
      setBaseline(next)
      setSaveDialogOpen(false)
      setAgentChange(null)
      setAgentDiffOpen(false)
      setAgentTargetSession((value) => value + 1)
      return
    }
    if (
      !window.confirm(
        `${draft.name || `Calculation #${draft.id}`}을 영구 삭제할까요?${dirty ? '\n저장하지 않은 편집도 함께 사라집니다.' : ''}`,
      )
    ) {
      return
    }
    const sequence = ++mutationSequenceRef.current
    setDeleting(true)
    try {
      await dbTables.Calculation.deleteRows([draft.id])
      if (sequence !== mutationSequenceRef.current) {
        await queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'calculations'] })
        await queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'calculation-data'] })
        await queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'measurements'] })
        await queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'experiments'] })
        return
      }
      const next = emptyCalculationDraft()
      setDraft(next)
      setBaseline(next)
      setSaveDialogOpen(false)
      setAgentChange(null)
      setAgentDiffOpen(false)
      setAgentTargetSession((value) => value + 1)
      selectedCalculationRef.current = null
      onCalculationIdChange(null)
      await queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'calculations'] })
      await queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'calculation-data'] })
      await queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'measurements'] })
      await queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'experiments'] })
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
      setAgentDiffOpen(true)
      return
    }
    invalidatePreview('AI source 변경을 되돌리는 중…')
    setDraft((value) => ({ ...value, sourceCode: agentChange.before }))
    setAgentChange(null)
    setAgentDiffOpen(false)
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
                  disabled={!editable || experimentId === null || saving || deleting || calculationDataBusy}
                  size="icon"
                  title="New"
                  type="button"
                  variant="outline"
                  onClick={() => replaceDraft(emptyCalculationDraft(), null)}
                >
                  <FilePlus2 />
                </Button>
                <Button
                  aria-label="선택한 Calculation 삭제"
                  disabled={!editable || saving || deleting || calculationDataBusy || (draft.id === null && !dirty)}
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
                        onClick={() => replaceDraft(calculationDraft(row), row.id)}
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
                  <Button size="sm" type="button" variant="outline" onClick={() => setAgentDiffOpen((value) => !value)}>
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
                    onClick={() => {
                      setAgentChange(null)
                      setAgentDiffOpen(false)
                    }}
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
                  diagnostic={preview.status === 'error' && preview.code === 'policy' ? preview.diagnostic : undefined}
                  disabled={saving || deleting || calculationDataBusy}
                  sourceCode={draft.sourceCode}
                  onSave={saveFromShortcut}
                  onSourceCodeChange={(sourceCode) => {
                    invalidatePreview('Source 변경을 기다리는 중…')
                    setDraft((current) => ({ ...current, sourceCode }))
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
                  enabled={authenticated}
                  experimentId={experimentId}
                  selectedId={measurementId}
                  onClearSelection={() => {
                    invalidatePreview('Measurement 선택을 해제하는 중…')
                    onClearMeasurement()
                  }}
                  onDelete={onDeleteMeasurements}
                  onSelect={(row) => {
                    invalidatePreview('Measurement RecordedData를 불러오는 중…')
                    onSelectMeasurement(row)
                  }}
                />
              ) : (
                <VarsPanel
                  candidateSessionKey={candidateSessionKey}
                  disabled={candidateEditingDisabled}
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
                    ? 'Calculation을 저장하면 다른 Measurement와 비교할 수 있습니다.'
                    : dirty
                      ? '수정한 Calculation을 저장한 뒤 비교 데이터를 다시 계산하세요.'
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
          <section className="flex h-full min-h-0 flex-col p-2">
            <h2 className="mb-2 shrink-0 text-sm font-semibold">RecordedData</h2>
            <div className="min-h-0 flex-1 overflow-auto rounded border">
              {measurementId === null ? (
                <div className="grid h-full min-h-20 place-items-center p-3 text-center text-xs text-muted-foreground">
                  Measurement를 선택하세요.
                </div>
              ) : recordedSnapshot.summaries.length ? (
                <ul className="divide-y">
                  {recordedSnapshot.summaries.map((summary) => (
                    <li
                      className="space-y-1 px-2 py-2 text-[11px]"
                      key={summary.path}
                      title={summary.error ?? undefined}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 truncate font-mono font-medium">{summary.path}</span>
                        <Badge className={summary.valid ? 'bg-emerald-600 text-white' : 'bg-destructive text-white'}>
                          axes {summary.actualAxisLengths ? JSON.stringify(summary.actualAxisLengths) : '—'}
                          {summary.valid ? '' : ' · invalid'}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap gap-x-3 text-muted-foreground">
                        <span>QuantityKind: {summary.quantityKind ?? '—'}</span>
                        <span>unit: {summary.unit ?? '—'}</span>
                      </div>
                      {summary.error ? <p className="line-clamp-2 text-destructive">{summary.error}</p> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="grid h-full min-h-20 place-items-center p-3 text-center text-xs text-muted-foreground">
                  RecordedData가 없습니다.
                </div>
              )}
            </div>
          </section>
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
