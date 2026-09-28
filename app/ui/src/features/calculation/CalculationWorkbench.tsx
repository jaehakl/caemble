import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileCode2, FilePlus2, FolderOpen, LoaderCircle, Save, Trash2 } from 'lucide-react'
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
import { calculationLibraryApi } from '@/api/calculationLibrary'
import { dbTables, getListRequest, type CalculationOutputLayout, type ExperimentRecordedDataRecord } from '@/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import {
  WorkbenchRibbonGroup,
  WorkbenchRibbonActions,
  WorkbenchRibbonButton,
} from '@/features/cae-workbench/chrome/WorkbenchRibbon'
import { usePrivateQueryScope } from '@/features/auth/use-auth'
import type { SavedMeasurement, WorkbenchCalculationSelection } from '@/features/cae-workbench/types'
import { analyzeCalculationDependencies, calculationSourceSkeleton, calculationSourceHash } from '@/lib/calculation'
import type { RecordedData, RecordedDataRule } from '@/lib/cad/model'
import { cn } from '@/lib/utils'
import { buildCalculationRecordedData } from './calculationRecordedData'
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
import { requiredCalculationRecordedDataRules } from './experimentRecordCatalogModel'
import { CalculationSourceEditor } from './CalculationSourceEditor'
import { ResizableCalculationLayout } from './ResizableCalculationLayout'
import { useCalculationPreview } from './useCalculationPreview'
import { experimentRecordsQueryOptions } from '../experiment/queryOptions'
import { measurementsQueryOptions } from '../measurement/queryOptions'
import { invalidateCalculationMutation } from './queryInvalidation'
import { CalculationLibraryDialog } from './CalculationLibraryDialog'

export type CalculationSaveState = Readonly<{
  disabled: boolean
  disabledReason?: string
}>

export type CalculationWorkbenchProps = Readonly<{
  authenticated: boolean
  dataReadable: boolean
  calculationDataBusy: boolean
  columnRatios: readonly number[]
  contextPending: boolean
  persistable: boolean
  sourceEditable: boolean
  experimentSolverNames: readonly string[]
  experimentId: number | null
  measurementId: number | null
  measurementLoading: boolean
  measurementSelectionPending: boolean
  menubar: ReactNode
  onActivity: RuntimeActivityCallback
  onCalculationSelectionChange: (selection: WorkbenchCalculationSelection) => boolean
  onColumnRatiosChange: (ratios: readonly [number, number]) => void
  onDirtyChange: (dirty: boolean) => void
  onOutputChartRatioChange: (ratio: number) => void
  onRequestLogin: () => void
  onSaveStateChange: (state: CalculationSaveState) => void
  onUsageChanged: () => Promise<void>
  publicDemoMutable: boolean
  onSelectMeasurement: (row: SavedMeasurement) => void
  recordedData: RecordedData | null | undefined
  recordedRules: readonly RecordedDataRule[]
  ribbon: (controls: ReactNode) => ReactNode
  saveCommand: number
  outputChartRatio: number
  selectedCalculationId: number | null
}>

export function CalculationWorkbench({
  authenticated,
  dataReadable,
  calculationDataBusy,
  columnRatios,
  contextPending,
  persistable,
  sourceEditable,
  experimentSolverNames,
  experimentId,
  measurementId,
  measurementLoading,
  measurementSelectionPending,
  menubar,
  onActivity,
  onCalculationSelectionChange,
  onColumnRatiosChange,
  onDirtyChange,
  onOutputChartRatioChange,
  onRequestLogin,
  onSaveStateChange,
  onUsageChanged,
  publicDemoMutable,
  onSelectMeasurement,
  recordedData,
  recordedRules,
  ribbon,
  saveCommand,
  outputChartRatio,
  selectedCalculationId,
}: CalculationWorkbenchProps) {
  const changeCalculationSelection = useCallback(
    (calculationId: number | null) => onCalculationSelectionChange({ experimentId, calculationId }),
    [experimentId, onCalculationSelectionChange],
  )
  const queryClient = useQueryClient()
  const queryScope = usePrivateQueryScope()
  const [editing, dispatchEditing] = useReducer(calculationEditingReducer, initialCalculationEditingState)
  const { dirty, draft } = selectCalculationEditing(editing)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const deleting = deletingId !== null
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const appliedExperimentRef = useRef(experimentId)
  const selectedCalculationRef = useRef(selectedCalculationId)
  const defaultCalculationExperimentRef = useRef<number | null>(null)
  const defaultMeasurementExperimentRef = useRef<number | null>(null)
  const mutationSequenceRef = useRef(0)
  const appliedSaveCommandRef = useRef(saveCommand)
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
    () => (calculationsQuery.data?.items ?? []).filter((row) => typeof row.id === 'number'),
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
  const recordedSnapshot = useMemo(
    () => buildCalculationRecordedData(requiredRules, recordedData),
    [recordedData, requiredRules],
  )
  const { invalidatePreview, preview, logs } = useCalculationPreview({
    calculationDataBusy,
    contextPending,
    dependencyError: dependencyState.error,
    draft,
    experimentId,
    experimentRecordsPending: dataReadable && experimentId !== null && experimentRecordsQuery.isPending,
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
    (selectedRow?.source_code === draft.sourceCode
      ? undefined
      : experimentRecordsQuery.isPending
        ? 'ExperimentRecord 계약을 불러오는 중입니다.'
        : dependencyState.error
          ? dependencyState.error.message
          : requiresPreflight && preview.status !== 'success' && selectedRow?.source_code !== draft.sourceCode
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
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  useEffect(
    () => onSaveStateChange({ disabled: saveDisabledReason !== undefined, disabledReason: saveDisabledReason }),
    [onSaveStateChange, saveDisabledReason],
  )

  useEffect(() => {
    if (appliedExperimentRef.current === experimentId) return
    appliedExperimentRef.current = experimentId
    setLibraryOpen(false)
    mutationSequenceRef.current += 1
    setSaving(false)
    setDeletingId(null)
    setSaveDialogOpen(false)
    dispatchEditing({ type: 'experimentChanged', recordName: experimentRecords[0]?.name })
  }, [experimentId, experimentRecords])

  useEffect(() => {
    if (selectedCalculationRef.current === selectedCalculationId) return
    selectedCalculationRef.current = selectedCalculationId
    mutationSequenceRef.current += 1
    setSaving(false)
    setDeletingId(null)
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
    if (dirty) {
      dispatchEditing({ type: 'serverSnapshotMissing', recordName: experimentRecords[0]?.name })
      return
    }
    if (!changeCalculationSelection(null)) return
    dispatchEditing({ type: 'serverSnapshotMissing', recordName: experimentRecords[0]?.name })
    selectedCalculationRef.current = null
    toast.error('선택한 Calculation이 없거나 현재 Experiment에 속하지 않습니다.')
  }, [
    calculationsQuery.isFetching,
    calculationsQuery.isSuccess,
    contextPending,
    dirty,
    experimentRecords,
    changeCalculationSelection,
    rows,
    selectedCalculationId,
  ])

  const replaceDraft = useCallback(
    (next: CalculationDraft, nextId: number | null, serverSnapshot: SavedCalculation | null = null) => {
      if (saving || deleting) return false
      if (dirty && !window.confirm('저장하지 않은 Calculation 편집을 버리고 선택을 바꿀까요?')) return false
      if (!changeCalculationSelection(nextId)) return false
      setSaveDialogOpen(false)
      invalidatePreview('Calculation source를 바꾸는 중…')
      dispatchEditing({ type: 'draftReplaced', draft: next, serverSnapshot })
      return true
    },
    [changeCalculationSelection, deleting, dirty, invalidatePreview, saving],
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
      if (baseSaveDisabledReason) return false
      const description = (values?.description ?? draft.description).trim()
      if (
        selectedRow &&
        draft.sourceCode === selectedRow.source_code &&
        name === selectedRow.name &&
        description === (selectedRow.description ?? '')
      )
        return true
      const sequence = ++mutationSequenceRef.current
      setSaving(true)
      try {
        if (
          selectedRow &&
          draft.sourceCode === selectedRow.source_code &&
          (name !== selectedRow.name || description !== (selectedRow.description ?? ''))
        ) {
          if (!draft.baseSourceRevision) throw new Error('공유 정의 revision을 확인할 수 없습니다. 다시 불러오세요.')
          const result = await calculationLibraryApi.updateMetadata(selectedRow.id, {
            name,
            description: description || null,
            base_source_revision: draft.baseSourceRevision,
          })
          if (sequence === mutationSequenceRef.current)
            dispatchEditing({
              type: 'saveCommitted',
              draft: {
                ...draft,
                name,
                description,
                baseRevision: result.revision,
                baseSourceRevision: result.source_revision,
              },
            })
          await invalidateCalculationMutation(queryClient, queryScope, experimentId)
          toast.success('공유 정의의 이름·설명을 변경했습니다.')
          return true
        }
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
        if (draft.id !== null && draft.baseRevision === null) {
          throw new Error('Calculation revision을 확인할 수 없습니다. 최신 항목을 다시 불러오세요.')
        }
        const [result] = await dbTables.Calculation.upsertRow([
          {
            ...(draft.id === null ? {} : { id: draft.id }),
            ...(draft.id === null ? {} : { base_revision: draft.baseRevision }),
            base_source_revision: draft.baseSourceRevision,
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
        const next = {
          ...draft,
          description,
          id: result.id,
          baseRevision: result.revision,
          baseSourceRevision: result.source_revision,
          name,
        }
        if (changeCalculationSelection(result.id)) {
          dispatchEditing({ type: 'saveCommitted', draft: next })
          selectedCalculationRef.current = result.id
        }
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
      baseSaveDisabledReason,
      draft,
      dependencyState.error,
      dependencyState.names,
      demoSandbox,
      experimentId,
      experimentRecords,
      measurementId,
      changeCalculationSelection,
      onUsageChanged,
      persistable,
      queryClient,
      queryScope,
      preview,
      requiresPreflight,
      selectedRow,
    ],
  )

  const openSaveDialog = useCallback(() => {
    if (!authenticated) {
      onRequestLogin()
      return
    }
    if (baseSaveDisabledReason) {
      toast.error(baseSaveDisabledReason)
      return
    }
    setSaveDialogOpen(true)
  }, [authenticated, onRequestLogin, baseSaveDisabledReason])

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
    if (contextPending) {
      setSaveDialogOpen(false)
      setLibraryOpen(false)
    }
  }, [contextPending])

  useEffect(
    () => () => onSaveStateChange({ disabled: true, disabledReason: 'Calculation Editor를 불러오는 중입니다.' }),
    [onSaveStateChange],
  )

  const deleteCalculation = async (target: Pick<CalculationDraft, 'id' | 'name'> = draft) => {
    if (saving || deleting || calculationDataBusy || contextPending) return
    if (target.id === null) {
      if (!sourceEditable) return
      if (dirty && !window.confirm('저장하지 않은 새 Calculation draft를 버릴까요?')) return
      dispatchEditing({ type: 'newStarted', recordName: experimentRecords[0]?.name })
      setSaveDialogOpen(false)
      return
    }
    if (!persistable) return
    const isCurrent = target.id === draft.id
    if (
      !window.confirm(
        `이 Experiment에서 ${target.name || `Calculation #${target.id}`} 연결과 후처리 결과를 삭제할까요?${isCurrent && dirty ? '\n저장하지 않은 편집도 함께 사라집니다.' : ''}${publicDemoMutable ? '\n공개 Demo 데이터에 즉시 반영되며 Prediction이 Not Ready가 될 수 있습니다.' : ''}`,
      )
    ) {
      return
    }
    const sequence = ++mutationSequenceRef.current
    setDeletingId(target.id)
    try {
      await dbTables.Calculation.deleteRows([target.id])
      if (sequence !== mutationSequenceRef.current) {
        await invalidateCalculationMutation(queryClient, queryScope, experimentId)
        return
      }
      if (isCurrent && changeCalculationSelection(null)) {
        dispatchEditing({ type: 'deleted', recordName: experimentRecords[0]?.name })
        setSaveDialogOpen(false)
        selectedCalculationRef.current = null
      }
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
      if (sequence === mutationSequenceRef.current) setDeletingId(null)
    }
  }

  const editorKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== 's') return
    if (event.target instanceof Element && event.target.closest('.monaco-editor')) return
    event.preventDefault()
    saveFromShortcut()
  }

  const sourceEditorDisabled =
    !sourceEditable || saving || deleting || calculationDataBusy || contextPending || selectedCalculationId !== draft.id

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="shrink-0">
        {menubar}
        {ribbon(
          <>
            <WorkbenchRibbonGroup label="불러오기">
              <WorkbenchRibbonButton
                icon={<FolderOpen />}
                label="불러오기"
                size="large"
                disabled={contextPending}
                onClick={() => setLibraryOpen(true)}
              />
            </WorkbenchRibbonGroup>
            <WorkbenchRibbonGroup label="Calculation 선택">
              <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
                <DialogTrigger asChild>
                  <WorkbenchRibbonButton
                    disabled={contextPending}
                    icon={<FileCode2 />}
                    label="Calculations"
                    size="large"
                  />
                </DialogTrigger>
                <DialogContent
                  aria-describedby={undefined}
                  className="flex h-[70dvh] max-h-[85dvh] flex-col overflow-hidden sm:max-w-4xl"
                >
                  <DialogHeader>
                    <DialogTitle>Calculations</DialogTitle>
                  </DialogHeader>
                  <div className="min-h-0 flex-1 overflow-auto">
                    <section className="flex h-full min-h-0 flex-col gap-2 p-2" aria-label="Calculation 목록">
                      <header className="flex shrink-0 items-center justify-end gap-2">
                        <div className="flex gap-1">
                          <Button
                            aria-label="선택한 Calculation 삭제"
                            disabled={
                              saving ||
                              deleting ||
                              calculationDataBusy ||
                              contextPending ||
                              (draft.id === null ? !sourceEditable || !dirty : !persistable)
                            }
                            size="icon"
                            title="Delete"
                            type="button"
                            variant="outline"
                            onClick={() => void deleteCalculation()}
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
                              <li key={row.id} className="flex items-center gap-2 pr-2">
                                <button
                                  aria-current={draft.id === row.id ? 'true' : undefined}
                                  className={cn(
                                    'min-w-0 flex-1 px-3 py-2 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                                    draft.id === row.id && 'bg-accent',
                                  )}
                                  disabled={saving || deleting || calculationDataBusy || contextPending}
                                  type="button"
                                  onClick={() => {
                                    if (replaceDraft(calculationDraftFromRecord(row), row.id, row)) setPickerOpen(false)
                                  }}
                                >
                                  <span className="block truncate font-medium text-foreground">{row.name}</span>
                                  <span className="mt-0.5 block truncate text-muted-foreground">
                                    {row.description || `Calculation #${row.id}`}
                                  </span>
                                  <span className="mt-1 block text-muted-foreground">
                                    {row.contract_status === 'ready' ? '준비됨' : '사전 검증 필요'}
                                    {' · '}
                                    {calculationsQuery.isFetching
                                      ? '저장 현황 조회 중…'
                                      : `저장 ${row.calculation_data_count} / 기록 완료 ${row.recorded_measurement_count} · 전체 ${row.measurement_count} Measurements`}
                                  </span>
                                </button>
                                <Button
                                  aria-label={`${row.name} 삭제`}
                                  title={`${row.name} 삭제`}
                                  size="icon"
                                  type="button"
                                  variant="outline"
                                  className="shrink-0"
                                  disabled={!persistable || saving || deleting || calculationDataBusy || contextPending}
                                  onClick={() => void deleteCalculation(row)}
                                >
                                  {deletingId === row.id ? (
                                    <LoaderCircle aria-label="삭제 중" className="animate-spin" />
                                  ) : (
                                    <Trash2 />
                                  )}
                                </Button>
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
                  </div>
                </DialogContent>
              </Dialog>
            </WorkbenchRibbonGroup>
            <WorkbenchRibbonGroup label="Calculation 작성">
              <WorkbenchRibbonActions
                size="large"
                actions={[
                  {
                    id: 'new-calculation',
                    label: '새 Calculation',
                    icon: <FilePlus2 />,
                    disabled: sourceEditorDisabled || experimentId === null,
                    onSelect: () => {
                      defaultCalculationExperimentRef.current = experimentId
                      replaceDraft(emptyCalculationDraft(experimentRecords[0]?.name), null)
                    },
                  },
                  {
                    id: 'save-calculation',
                    label: 'Calculation 정보',
                    icon: <Save />,
                    primary: true,
                    disabled: !!baseSaveDisabledReason,
                    disabledReason: baseSaveDisabledReason,
                    onSelect: openSaveDialog,
                  },
                ]}
              />
            </WorkbenchRibbonGroup>
          </>,
        )}
      </header>
      <ResizableCalculationLayout
        columnRatios={columnRatios}
        editor={
          <section className="flex h-full min-h-0 flex-col" onKeyDown={editorKeyDown}>
            {demoSandbox ? (
              <div className="shrink-0 border-b bg-sky-50 px-3 py-1.5 text-xs text-sky-950">
                Demo 원본과 저장 데이터는 읽기 전용입니다. 이 source 변경은 로컬 Preview에만 적용됩니다.
              </div>
            ) : null}
            <div className="min-h-0 flex-1">
              <CalculationSourceEditor
                diagnostic={preview.status === 'error' && preview.code === 'policy' ? preview.diagnostic : undefined}
                disabled={sourceEditorDisabled}
                sourceCode={draft.sourceCode}
                onSave={saveFromShortcut}
                onSourceCodeChange={(sourceCode) => {
                  invalidatePreview('Source 변경을 기다리는 중…')
                  dispatchEditing({ type: 'sourceEdited', sourceCode })
                }}
              />
            </div>
          </section>
        }
        onColumnRatiosChange={(ratios) => onColumnRatiosChange(ratios as readonly [number, number])}
        output={
          <section className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-hidden">
              <ResizableCalculationOutput
                calculationName={draft.name}
                chartRatio={outputChartRatio}
                comparisonMessage={
                  scalarQuery.isFetching
                    ? '저장된 비교 데이터를 불러오는 중…'
                    : scalarQuery.isError
                      ? '저장된 비교 데이터를 불러오지 못했습니다.'
                      : undefined
                }
                measurementId={measurementId}
                preview={preview}
                logs={logs}
                scalarValues={scalarQuery.isFetching ? undefined : scalarQuery.data?.items.map((item) => item.value)}
                onChartRatioChange={onOutputChartRatioChange}
              />
            </div>
          </section>
        }
      />
      {libraryOpen && !contextPending && appliedExperimentRef.current === experimentId ? (
        <CalculationLibraryDialog
          key={`${experimentId}:${queryScope}`}
          defaultSolverNames={experimentSolverNames}
          loadDisabled={sourceEditorDisabled}
          onClose={() => setLibraryOpen(false)}
          onLoad={(item) => {
            if (sourceEditorDisabled) return false
            const next: CalculationDraft = {
              id: null,
              baseRevision: null,
              name: item.name,
              description: item.description ?? '',
              sourceCode: item.source_code,
            }
            if (!replaceDraft(next, null)) return false
            // Selection effects must not replace the imported draft with the
            // empty skeleton or the Experiment's default saved Calculation.
            selectedCalculationRef.current = null
            defaultCalculationExperimentRef.current = experimentId
            dispatchEditing({ type: 'draftImported', draft: next })
            return true
          }}
        />
      ) : null}
      <CalculationSaveDialog
        defaults={{ description: draft.description, name: draft.name }}
        disabledReason={saveDisabledReason}
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
