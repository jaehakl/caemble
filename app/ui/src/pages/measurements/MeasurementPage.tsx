import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  Box,
  ChartNoAxesCombined,
  FlaskConical,
  LoaderCircle,
  LogIn,
  Pencil,
  Play,
  Plus,
  Rows3,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { dbTables, getListRequest } from '@/api'
import type {
  ExperimentRecord,
  GetListResponse,
  MeasurementRecord,
  MeasurementSaveRequest,
  RecordedDataRecord,
  SampleRecord,
  SetupRecord,
  StructureRecord,
} from '@/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAuth } from '@/features/auth/use-auth'
import { useCurrentCadSelection } from '@/features/viewer/current-cad-selection'
import { createSampleRecord, createSetupRecord } from '@/features/viewer/persistence/contracts'
import { resolveDocumentMaterials } from '@/features/viewer/persistence/resolveMaterials'
import CadViewer from '@/features/viewer/viewer/CadViewer'
import { useCadWorkspace } from '@/features/viewer/workspace/useCadWorkspace'
import {
  createCadSourceDocument,
  createDataTensorAccessor,
  MAX_RECORDED_DATA_BYTES,
  persistDataSchema,
  persistDataTensor,
  type CadDocumentType,
  type CadSourceDocument,
  type EvaluatedDocumentSnapshot,
  type RecordedData,
  type Vars,
} from '@/lib/cad'
import type { MaterialResolution } from '@/lib/material'

function positiveId(value: string | null) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

type MeasurementSelection = {
  measurementId: number | null
  sampleId: number | null
  setupId: number | null
}

type MeasurementRunQueue = {
  cancelRequested: boolean
  failures: readonly { message: string; sampleId: number }[]
  index: number
  minimumStructureRevision: number | null
  mode: 'batch' | 'generated' | 'single'
  originalSelection: MeasurementSelection
  runId: string | null
  sampleIds: readonly number[]
  setupId: number
  stage: 'complete' | 'evaluate' | 'load' | 'running' | 'saving'
  successes: readonly { measurementId: number; sampleId: number }[]
}

type MeasurementRunSummary = {
  cancelled: boolean
  failures: readonly { message: string; sampleId: number }[]
  successCount: number
  total: number
}

export function MeasurementPage() {
  const auth = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const { currentExperimentId, currentStructureId, setCurrentExperimentId, setCurrentStructureId } =
    useCurrentCadSelection()
  const [structure, setStructure] = useState<CadSourceDocument | null>(null)
  const [experiment, setExperiment] = useState<CadSourceDocument | null>(null)
  const [structureRecord, setStructureRecord] = useState<StructureRecord | null>(null)
  const [experimentRecord, setExperimentRecord] = useState<ExperimentRecord | null>(null)
  const [structureVars, setStructureVars] = useState<Readonly<Vars> | undefined>()
  const [experimentVars, setExperimentVars] = useState<Readonly<Vars> | undefined>()
  const [structureMaterialSnapshot, setStructureMaterialSnapshot] = useState<unknown | null>(null)
  const [experimentMaterialSnapshot, setExperimentMaterialSnapshot] = useState<unknown | null>(null)
  const [selectedSampleId, setSelectedSampleId] = useState<number | null>(null)
  const [selectedSetupId, setSelectedSetupId] = useState<number | null>(null)
  const [selectedMeasurementId, setSelectedMeasurementId] = useState<number | null>(null)
  const [initialDeepLinkSelection] = useState(() => ({
    sampleId: positiveId(searchParams.get('sample')),
    setupId: positiveId(searchParams.get('setup')),
  }))
  const [selectingDefaults, setSelectingDefaults] = useState(false)
  const [urlInitializationComplete, setUrlInitializationComplete] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<'measurement' | 'sample' | 'setup' | null>(null)
  const [hideLiveRecordedData, setHideLiveRecordedData] = useState(false)
  const [pendingRealization, setPendingRealization] = useState<{
    kind: 'sample' | 'setup'
    minimumRevision: number
    originalSelection: MeasurementSelection | null
    runSetupId: number | null
  } | null>(null)
  const [runQueue, setRunQueue] = useState<MeasurementRunQueue | null>(null)
  const [runSummary, setRunSummary] = useState<MeasurementRunSummary | null>(null)
  const defaultSelectionContext = useRef<string | null>(null)
  const initializedFromUrl = useRef(false)
  const runPreviousRecordedData = useRef<RecordedData | null>(null)

  const updateDeepLink = useCallback(
    (updates: Partial<Record<'experiment' | 'measurement' | 'sample' | 'setup' | 'structure', number | null>>) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          Object.entries(updates).forEach(([key, value]) => {
            if (value) next.set(key, String(value))
            else next.delete(key)
          })
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const samplesQuery = useQuery({
    queryKey: ['measurements', 'samples', currentStructureId],
    queryFn: () =>
      dbTables.Sample.listRows({
        ...getListRequest('mine'),
        limit: null,
        filter: { structure_id: [currentStructureId, currentStructureId] },
      }),
    enabled: auth.isAuthenticated && currentStructureId !== null,
  })
  const setupsQuery = useQuery({
    queryKey: ['measurements', 'setups', currentExperimentId],
    queryFn: () =>
      dbTables.Setup.listRows({
        ...getListRequest('mine'),
        limit: null,
        filter: { experiment_id: [currentExperimentId, currentExperimentId] },
      }),
    enabled: auth.isAuthenticated && currentExperimentId !== null,
  })
  const measurementsQuery = useQuery({
    queryKey: ['measurements', 'context', currentStructureId, currentExperimentId],
    queryFn: () => dbTables.Measurement.listContext(currentStructureId!, currentExperimentId!),
    enabled: auth.isAuthenticated && currentStructureId !== null && currentExperimentId !== null,
  })
  const recordedDataQuery = useQuery({
    queryKey: ['measurements', 'recorded-data', selectedMeasurementId],
    queryFn: () =>
      dbTables.RecordedData.listRows({
        ...getListRequest('mine'),
        limit: null,
        filter: { measurement_id: [selectedMeasurementId, selectedMeasurementId] },
      }),
    enabled: auth.isAuthenticated && selectedMeasurementId !== null,
  })

  const samples = useMemo(
    () => (samplesQuery.data?.items ?? []).filter((row): row is SampleRecord & { id: number } => row.id !== undefined),
    [samplesQuery.data?.items],
  )
  const setups = useMemo(
    () => (setupsQuery.data?.items ?? []).filter((row): row is SetupRecord & { id: number } => row.id !== undefined),
    [setupsQuery.data?.items],
  )
  const measurements = useMemo(
    () =>
      (measurementsQuery.data?.items ?? []).filter(
        (row): row is MeasurementRecord & { id: number } => row.id !== undefined,
      ),
    [measurementsQuery.data?.items],
  )
  const unmeasuredSamples = useMemo(
    () =>
      selectedSetupId === null
        ? []
        : samples.filter(
            (sample) =>
              !measurements.some(
                (measurement) => measurement.sample_id === sample.id && measurement.setup_id === selectedSetupId,
              ),
          ),
    [measurements, samples, selectedSetupId],
  )

  const resolveMaterials = useCallback(
    (snapshot: EvaluatedDocumentSnapshot): Promise<MaterialResolution> =>
      resolveDocumentMaterials(
        snapshot,
        snapshot.kind === 'structure' ? structureMaterialSnapshot : experimentMaterialSnapshot,
      ),
    [experimentMaterialSnapshot, structureMaterialSnapshot],
  )
  const { experimentDocument, simulation, structureDocument } = useCadWorkspace(
    structure,
    experiment,
    setStructure,
    setExperiment,
    structureVars,
    experimentVars,
    resolveMaterials,
    'fast-reroll',
    auth.user?.gpstation_connection,
  )
  const structureRevisionRef = useRef(structureDocument.revision)
  structureRevisionRef.current = structureDocument.revision

  const fetchStructure = useCallback(async (id: number) => {
    return (await dbTables.Structure.listRows(getListRequest('visible', [id]))).items[0] ?? null
  }, [])
  const fetchExperiment = useCallback(async (id: number) => {
    return (await dbTables.Experiment.listRows(getListRequest('visible', [id]))).items[0] ?? null
  }, [])
  const fetchSample = useCallback(async (id: number) => {
    return (await dbTables.Sample.listRows(getListRequest('mine', [id]))).items[0] ?? null
  }, [])
  const fetchSetup = useCallback(async (id: number) => {
    return (await dbTables.Setup.listRows(getListRequest('mine', [id]))).items[0] ?? null
  }, [])
  const fetchMeasurement = useCallback(async (id: number) => {
    return (await dbTables.Measurement.listRows(getListRequest('mine', [id]))).items[0] ?? null
  }, [])

  const applyStructure = useCallback(
    (record: StructureRecord, resetRealization: boolean) => {
      if (!record.id) throw new Error('Structure ID가 없습니다.')
      setStructure(createCadSourceDocument('structure', record.code))
      setStructureRecord(record)
      setCurrentStructureId(record.id)
      if (resetRealization) {
        setStructureVars(undefined)
        setStructureMaterialSnapshot(null)
        setSelectedSampleId(null)
      }
    },
    [setCurrentStructureId],
  )
  const applyExperiment = useCallback(
    (record: ExperimentRecord, resetRealization: boolean) => {
      if (!record.id) throw new Error('Experiment ID가 없습니다.')
      setExperiment(createCadSourceDocument('experiment', record.code, undefined, record.simulation_code))
      setExperimentRecord(record)
      setCurrentExperimentId(record.id)
      if (resetRealization) {
        setExperimentVars(undefined)
        setExperimentMaterialSnapshot(null)
        setSelectedSetupId(null)
      }
    },
    [setCurrentExperimentId],
  )

  const loadStructure = useCallback(
    async (id: number, updateUrl = true) => {
      const record = await fetchStructure(id)
      if (!record) throw new Error('Structure를 찾을 수 없습니다.')
      applyStructure(record, true)
      setSelectedMeasurementId(null)
      setHideLiveRecordedData(true)
      if (updateUrl) updateDeepLink({ structure: id, sample: null, measurement: null })
      return record
    },
    [applyStructure, fetchStructure, updateDeepLink],
  )
  const loadExperiment = useCallback(
    async (id: number, updateUrl = true) => {
      const record = await fetchExperiment(id)
      if (!record) throw new Error('Experiment를 찾을 수 없습니다.')
      applyExperiment(record, true)
      setSelectedMeasurementId(null)
      setHideLiveRecordedData(true)
      if (updateUrl) updateDeepLink({ experiment: id, setup: null, measurement: null })
      return record
    },
    [applyExperiment, fetchExperiment, updateDeepLink],
  )
  const loadSample = useCallback(
    async (id: number, updateUrl = true, loadedSample?: SampleRecord) => {
      const sample = loadedSample?.id === id ? loadedSample : await fetchSample(id)
      if (!sample) throw new Error('Sample을 찾을 수 없습니다.')
      if (!structure || currentStructureId !== sample.structure_id) {
        const parent = await fetchStructure(sample.structure_id)
        if (!parent) throw new Error('Sample의 Structure를 찾을 수 없습니다.')
        applyStructure(parent, false)
      }
      setStructureVars(sample.vars as Readonly<Vars>)
      setStructureMaterialSnapshot(sample.material_parameters)
      setSelectedSampleId(id)
      setSelectedMeasurementId(null)
      setHideLiveRecordedData(true)
      if (updateUrl) updateDeepLink({ structure: sample.structure_id, sample: id, measurement: null })
      return sample
    },
    [applyStructure, currentStructureId, fetchSample, fetchStructure, structure, updateDeepLink],
  )
  const loadSetup = useCallback(
    async (id: number, updateUrl = true, loadedSetup?: SetupRecord) => {
      const setup = loadedSetup?.id === id ? loadedSetup : await fetchSetup(id)
      if (!setup) throw new Error('Setup을 찾을 수 없습니다.')
      if (!experiment || currentExperimentId !== setup.experiment_id) {
        const parent = await fetchExperiment(setup.experiment_id)
        if (!parent) throw new Error('Setup의 Experiment를 찾을 수 없습니다.')
        applyExperiment(parent, false)
      }
      setExperimentVars(setup.vars as Readonly<Vars>)
      setExperimentMaterialSnapshot(setup.material_parameters)
      setSelectedSetupId(id)
      setSelectedMeasurementId(null)
      setHideLiveRecordedData(true)
      if (updateUrl) updateDeepLink({ experiment: setup.experiment_id, setup: id, measurement: null })
      return setup
    },
    [applyExperiment, currentExperimentId, experiment, fetchExperiment, fetchSetup, updateDeepLink],
  )
  const loadMeasurement = useCallback(
    async (id: number, updateUrl = true) => {
      const measurement = measurements.find((row) => row.id === id) ?? (await fetchMeasurement(id))
      if (!measurement) throw new Error('Measurement를 찾을 수 없습니다.')
      const [sample, setup] = await Promise.all([
        loadSample(measurement.sample_id, false),
        loadSetup(measurement.setup_id, false),
      ])
      setSelectedMeasurementId(id)
      if (updateUrl) {
        updateDeepLink({
          structure: sample.structure_id,
          experiment: setup.experiment_id,
          sample: measurement.sample_id,
          setup: measurement.setup_id,
          measurement: id,
        })
      }
      return measurement
    },
    [fetchMeasurement, loadSample, loadSetup, measurements, updateDeepLink],
  )

  useEffect(() => {
    if (initializedFromUrl.current || auth.isLoading) return
    initializedFromUrl.current = true

    const initialize = async () => {
      const measurementId = positiveId(searchParams.get('measurement'))
      const sampleId = positiveId(searchParams.get('sample'))
      const setupId = positiveId(searchParams.get('setup'))
      const structureId = positiveId(searchParams.get('structure')) ?? currentStructureId
      const experimentId = positiveId(searchParams.get('experiment')) ?? currentExperimentId

      if (measurementId && auth.isAuthenticated) {
        await loadMeasurement(measurementId)
        return
      }
      const [sample, setup] = await Promise.all([
        sampleId && auth.isAuthenticated
          ? loadSample(sampleId, false)
          : structureId
            ? loadStructure(structureId, false).then(() => null)
            : Promise.resolve(null),
        setupId && auth.isAuthenticated
          ? loadSetup(setupId, false)
          : experimentId
            ? loadExperiment(experimentId, false).then(() => null)
            : Promise.resolve(null),
      ])
      updateDeepLink({
        structure: sample?.structure_id ?? structureId ?? null,
        experiment: setup?.experiment_id ?? experimentId ?? null,
        sample: sample?.id ?? null,
        setup: setup?.id ?? null,
        measurement: null,
      })
    }

    void initialize()
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : 'Measurement 작업을 불러오지 못했습니다.')
        updateDeepLink({ measurement: null })
      })
      .finally(() => setUrlInitializationComplete(true))
  }, [
    auth.isAuthenticated,
    auth.isLoading,
    currentExperimentId,
    currentStructureId,
    loadExperiment,
    loadMeasurement,
    loadSample,
    loadSetup,
    loadStructure,
    searchParams,
    updateDeepLink,
  ])

  useEffect(() => {
    if (
      !urlInitializationComplete ||
      !auth.isAuthenticated ||
      currentStructureId === null ||
      currentExperimentId === null ||
      !samplesQuery.data ||
      !setupsQuery.data ||
      !measurementsQuery.data
    )
      return

    const contextKey = `${currentStructureId}:${currentExperimentId}`
    if (defaultSelectionContext.current === contextKey) return
    const isInitialContext = defaultSelectionContext.current === null
    defaultSelectionContext.current = contextKey

    const selectDefaults = async () => {
      if (selectedMeasurementId !== null) return

      const preferredSampleId = selectedSampleId ?? (isInitialContext ? initialDeepLinkSelection.sampleId : null)
      const preferredSetupId = selectedSetupId ?? (isInitialContext ? initialDeepLinkSelection.setupId : null)

      if (preferredSampleId === null && preferredSetupId === null && measurements[0]) {
        await loadMeasurement(measurements[0].id)
        return
      }

      const [sample, setup] = await Promise.all([
        preferredSampleId === null && samples[0] ? loadSample(samples[0].id, false, samples[0]) : Promise.resolve(null),
        preferredSetupId === null && setups[0] ? loadSetup(setups[0].id, false, setups[0]) : Promise.resolve(null),
      ])
      if (!sample && !setup) return

      const sampleId = sample?.id ?? preferredSampleId
      const setupId = setup?.id ?? preferredSetupId
      const matchingMeasurementId =
        measurements.find((measurement) => measurement.sample_id === sampleId && measurement.setup_id === setupId)
          ?.id ?? null
      setSelectedMeasurementId(matchingMeasurementId)
      setHideLiveRecordedData(true)
      updateDeepLink({
        sample: sampleId,
        setup: setupId,
        measurement: matchingMeasurementId,
      })
    }

    setSelectingDefaults(true)
    void selectDefaults()
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : '기본 Measurement 선택을 불러오지 못했습니다.'),
      )
      .finally(() => setSelectingDefaults(false))
  }, [
    auth.isAuthenticated,
    currentExperimentId,
    currentStructureId,
    initialDeepLinkSelection.sampleId,
    initialDeepLinkSelection.setupId,
    loadMeasurement,
    loadSample,
    loadSetup,
    measurements,
    measurementsQuery.data,
    samples,
    samplesQuery.data,
    selectedMeasurementId,
    selectedSampleId,
    selectedSetupId,
    setups,
    setupsQuery.data,
    updateDeepLink,
    urlInitializationComplete,
  ])

  useEffect(() => {
    if (auth.isLoading || auth.isAuthenticated) return
    setStructureVars(undefined)
    setExperimentVars(undefined)
    setStructureMaterialSnapshot(null)
    setExperimentMaterialSnapshot(null)
    setSelectedSampleId(null)
    setSelectedSetupId(null)
    setSelectedMeasurementId(null)
    setDeleteTarget(null)
    setHideLiveRecordedData(true)
    setPendingRealization(null)
    setRunQueue(null)
    setRunSummary(null)
    updateDeepLink({ sample: null, setup: null, measurement: null })
  }, [auth.isAuthenticated, auth.isLoading, updateDeepLink])

  useEffect(() => {
    if (!auth.isAuthenticated || selectedSampleId === null || selectedSetupId === null || !measurementsQuery.data)
      return

    const matchingMeasurement =
      measurements.find(
        (measurement) => measurement.sample_id === selectedSampleId && measurement.setup_id === selectedSetupId,
      ) ?? null
    const matchingMeasurementId = matchingMeasurement?.id ?? null
    if (selectedMeasurementId === matchingMeasurementId) return

    setSelectedMeasurementId(matchingMeasurementId)
    setHideLiveRecordedData(true)
    updateDeepLink({ measurement: matchingMeasurementId })
  }, [
    auth.isAuthenticated,
    measurements,
    measurementsQuery.data,
    selectedMeasurementId,
    selectedSampleId,
    selectedSetupId,
    updateDeepLink,
  ])

  const startRunQueue = useCallback(
    (
      sampleIds: readonly number[],
      setupId: number,
      mode: MeasurementRunQueue['mode'],
      firstSampleIsLoaded: boolean,
      originalSelection?: MeasurementSelection,
    ) => {
      if (sampleIds.length === 0) return
      setRunSummary(null)
      setSelectedMeasurementId(null)
      setHideLiveRecordedData(true)
      updateDeepLink({ measurement: null })
      setRunQueue({
        cancelRequested: false,
        failures: [],
        index: 0,
        mode,
        originalSelection: originalSelection ?? {
          measurementId: selectedMeasurementId,
          sampleId: selectedSampleId,
          setupId: selectedSetupId,
        },
        minimumStructureRevision: firstSampleIsLoaded ? structureDocument.revision : null,
        runId: null,
        sampleIds: [...sampleIds],
        setupId,
        stage: firstSampleIsLoaded ? 'evaluate' : 'load',
        successes: [],
      })
    },
    [selectedMeasurementId, selectedSampleId, selectedSetupId, structureDocument.revision, updateDeepLink],
  )

  const advanceRunQueue = useCallback(
    (sampleId: number, result: { measurementId: number; type: 'success' } | { message: string; type: 'failure' }) => {
      setRunQueue((current) => {
        if (!current || current.stage === 'complete' || current.sampleIds[current.index] !== sampleId) return current

        const successes =
          result.type === 'success'
            ? [...current.successes, { measurementId: result.measurementId, sampleId }]
            : current.successes
        const failures =
          result.type === 'failure' ? [...current.failures, { message: result.message, sampleId }] : current.failures
        const nextIndex = current.index + 1
        const complete = current.cancelRequested || nextIndex >= current.sampleIds.length
        return {
          ...current,
          failures,
          index: complete ? current.index : nextIndex,
          minimumStructureRevision: null,
          runId: null,
          stage: complete ? 'complete' : 'load',
          successes,
        }
      })
    },
    [],
  )

  const realizationMutation = useMutation({
    mutationFn: async ({
      kind,
    }: {
      kind: 'sample' | 'setup'
      minimumRevision: number
      originalSelection: MeasurementSelection | null
      runSetupId: number | null
    }) => {
      if (kind === 'sample') {
        if (!currentStructureId || !structureDocument.variables || !structureDocument.materialParameters) {
          throw new Error('Ready 상태의 Structure 실현값이 필요합니다.')
        }
        const record = createSampleRecord(
          currentStructureId,
          structureDocument.variables,
          structureDocument.materialParameters,
        )
        const [result] = await dbTables.Sample.upsertRow([record])
        return { id: result.id, kind, record: { ...record, id: result.id, updated_at: new Date().toISOString() } }
      }
      if (!currentExperimentId || !experimentDocument.variables || !experimentDocument.materialParameters) {
        throw new Error('Ready 상태의 Experiment 실현값이 필요합니다.')
      }
      const record = createSetupRecord(
        currentExperimentId,
        experimentDocument.variables,
        experimentDocument.materialParameters,
      )
      const [result] = await dbTables.Setup.upsertRow([record])
      return { id: result.id, kind, record: { ...record, id: result.id, updated_at: new Date().toISOString() } }
    },
    onSuccess: async ({ id, kind, record }, pending) => {
      if (kind === 'sample') {
        queryClient.setQueryData<GetListResponse<SampleRecord>>(
          ['measurements', 'samples', record.structure_id],
          (current) => ({
            total: current ? current.total + (current.items.some((item) => item.id === id) ? 0 : 1) : 1,
            items: [record, ...(current?.items ?? []).filter((item) => item.id !== id)],
          }),
        )
        setSelectedSampleId(id)
        updateDeepLink({ structure: record.structure_id, sample: id, measurement: null })
        await queryClient.invalidateQueries({ queryKey: ['measurements', 'samples', record.structure_id] })
        if (pending.runSetupId !== null && pending.originalSelection) {
          startRunQueue([id], pending.runSetupId, 'generated', true, pending.originalSelection)
        }
      } else {
        queryClient.setQueryData<GetListResponse<SetupRecord>>(
          ['measurements', 'setups', record.experiment_id],
          (current) => ({
            total: current ? current.total + (current.items.some((item) => item.id === id) ? 0 : 1) : 1,
            items: [record, ...(current?.items ?? []).filter((item) => item.id !== id)],
          }),
        )
        setSelectedSetupId(id)
        updateDeepLink({ experiment: record.experiment_id, setup: id, measurement: null })
        await queryClient.invalidateQueries({ queryKey: ['measurements', 'setups', record.experiment_id] })
      }
      toast.success(`${kind === 'sample' ? 'Sample' : 'Setup'}을 생성했습니다.`)
    },
    onError: (error, pending) => {
      if (pending.runSetupId !== null) {
        setRunSummary(null)
      }
      toast.error(error instanceof Error ? error.message : '실현값을 저장하지 못했습니다.')
    },
  })

  useEffect(() => {
    if (!pendingRealization || realizationMutation.isPending) return
    const document = pendingRealization.kind === 'sample' ? structureDocument : experimentDocument
    if (document.status === 'Error') {
      setPendingRealization(null)
      toast.error(`${pendingRealization.kind === 'sample' ? 'Sample' : 'Setup'} 생성 평가에 실패했습니다.`)
      return
    }
    if (
      document.revision < pendingRealization.minimumRevision ||
      document.successfulRevision !== document.revision ||
      document.status !== 'Ready'
    )
      return
    const pending = pendingRealization
    setPendingRealization(null)
    realizationMutation.mutate(pending)
  }, [experimentDocument, pendingRealization, realizationMutation, structureDocument])

  const measurementMutation = useMutation({
    mutationFn: (request: MeasurementSaveRequest) => dbTables.Measurement.save(request),
    onSuccess: async ({ id }, request) => {
      const updatedAt = new Date().toISOString()
      queryClient.setQueryData<GetListResponse<MeasurementRecord>>(
        ['measurements', 'context', currentStructureId, currentExperimentId],
        (current) => ({
          total: current ? current.total + (current.items.some((item) => item.id === id) ? 0 : 1) : 1,
          items: [
            {
              id,
              sample_id: request.sample_id,
              setup_id: request.setup_id,
              updated_at: updatedAt,
            },
            ...(current?.items ?? []).filter((item) => item.id !== id),
          ],
        }),
      )
      queryClient.setQueryData<GetListResponse<RecordedDataRecord>>(['measurements', 'recorded-data', id], {
        total: request.recorded_data.length,
        items: request.recorded_data.map((item) => ({ ...item, measurement_id: id, updated_at: updatedAt })),
      })
      setSelectedMeasurementId(id)
      updateDeepLink({ measurement: id })
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['measurements', 'context', currentStructureId, currentExperimentId],
        }),
        queryClient.invalidateQueries({ queryKey: ['measurements', 'recorded-data', id] }),
      ])
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (kind: 'measurement' | 'sample' | 'setup') => {
      const id = kind === 'sample' ? selectedSampleId : kind === 'setup' ? selectedSetupId : selectedMeasurementId
      if (!id) throw new Error('삭제할 항목이 선택되지 않았습니다.')
      if (kind === 'sample') await dbTables.Sample.deleteRows([id])
      else if (kind === 'setup') await dbTables.Setup.deleteRows([id])
      else await dbTables.Measurement.deleteRows([id])
      return { id, kind }
    },
    onSuccess: async ({ id, kind }) => {
      setDeleteTarget(null)
      setSelectedMeasurementId(null)
      setHideLiveRecordedData(true)
      queryClient.removeQueries({ queryKey: ['measurements', 'recorded-data'] })
      queryClient.setQueriesData<GetListResponse<MeasurementRecord>>(
        { queryKey: ['measurements', 'context'] },
        (current) => {
          if (!current) return current
          const items = current.items.filter((item) =>
            kind === 'sample' ? item.sample_id !== id : kind === 'setup' ? item.setup_id !== id : item.id !== id,
          )
          return { total: items.length, items }
        },
      )

      if (kind === 'sample') {
        queryClient.setQueriesData<GetListResponse<SampleRecord>>(
          { queryKey: ['measurements', 'samples'] },
          (current) => {
            if (!current) return current
            const items = current.items.filter((item) => item.id !== id)
            return { total: items.length, items }
          },
        )
        setSelectedSampleId(null)
        setStructureVars(undefined)
        setStructureMaterialSnapshot(null)
        updateDeepLink({ sample: null, measurement: null })
      } else if (kind === 'setup') {
        queryClient.setQueriesData<GetListResponse<SetupRecord>>(
          { queryKey: ['measurements', 'setups'] },
          (current) => {
            if (!current) return current
            const items = current.items.filter((item) => item.id !== id)
            return { total: items.length, items }
          },
        )
        setSelectedSetupId(null)
        setExperimentVars(undefined)
        setExperimentMaterialSnapshot(null)
        updateDeepLink({ setup: null, measurement: null })
      } else {
        updateDeepLink({ measurement: null })
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['measurements', 'context'] }),
        ...(kind === 'sample'
          ? [queryClient.invalidateQueries({ queryKey: ['measurements', 'samples'] })]
          : kind === 'setup'
            ? [queryClient.invalidateQueries({ queryKey: ['measurements', 'setups'] })]
            : []),
      ])
      toast.success(
        kind === 'sample'
          ? 'Sample과 연결된 Measurement를 삭제했습니다.'
          : kind === 'setup'
            ? 'Setup과 연결된 Measurement를 삭제했습니다.'
            : 'Measurement와 Recorded Data를 삭제했습니다.',
      )
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : '선택 항목을 삭제하지 못했습니다.'),
  })

  const currentRunSampleId = runQueue?.sampleIds[runQueue.index] ?? null

  useEffect(() => {
    if (runQueue?.stage !== 'load' || currentRunSampleId === null) return
    let active = true
    const minimumStructureRevision = structureRevisionRef.current + 1
    void loadSample(currentRunSampleId)
      .then(() => {
        if (!active) return
        setRunQueue((current) =>
          current?.stage === 'load' && current.sampleIds[current.index] === currentRunSampleId
            ? {
                ...current,
                minimumStructureRevision,
                runId: null,
                stage: current.cancelRequested ? 'complete' : 'evaluate',
              }
            : current,
        )
      })
      .catch((error: unknown) => {
        if (!active) return
        setRunQueue((current) => {
          if (current?.stage !== 'load' || current.sampleIds[current.index] !== currentRunSampleId) return current
          if (current.cancelRequested) return { ...current, stage: 'complete' }
          const message = error instanceof Error ? error.message : 'Sample을 불러오지 못했습니다.'
          const failures = [...current.failures, { message, sampleId: currentRunSampleId }]
          const nextIndex = current.index + 1
          const complete = nextIndex >= current.sampleIds.length
          return {
            ...current,
            failures,
            index: complete ? current.index : nextIndex,
            minimumStructureRevision: null,
            runId: null,
            stage: complete ? 'complete' : 'load',
          }
        })
      })
    return () => {
      active = false
    }
  }, [currentRunSampleId, loadSample, runQueue?.stage])

  useEffect(() => {
    if (
      runQueue?.stage !== 'evaluate' ||
      currentRunSampleId === null ||
      selectedSampleId !== currentRunSampleId ||
      selectedSetupId !== runQueue.setupId
    )
      return

    if (structureDocument.status === 'Error' || experimentDocument.status === 'Error') {
      advanceRunQueue(currentRunSampleId, {
        message: 'CAD 문서 평가에 실패했습니다.',
        type: 'failure',
      })
      return
    }
    if (
      runQueue.minimumStructureRevision === null ||
      structureDocument.revision < runQueue.minimumStructureRevision ||
      structureDocument.status !== 'Ready' ||
      experimentDocument.status !== 'Ready' ||
      structureDocument.successfulRevision !== structureDocument.revision ||
      experimentDocument.successfulRevision !== experimentDocument.revision ||
      simulation.compatibility.status === 'checking'
    )
      return

    if (simulation.compatibility.status === 'incompatible' || simulation.compatibility.status === 'unavailable') {
      advanceRunQueue(currentRunSampleId, {
        message: '현재 Sample과 Setup이 Solver 계약과 호환되지 않습니다.',
        type: 'failure',
      })
      return
    }
    if (!simulation.canRun) return

    const runId = simulation.run()
    if (!runId) return
    runPreviousRecordedData.current = simulation.recordedData
    setRunQueue((current) =>
      current?.stage === 'evaluate' && current.sampleIds[current.index] === currentRunSampleId
        ? { ...current, runId, stage: 'running' }
        : current,
    )
  }, [
    advanceRunQueue,
    currentRunSampleId,
    experimentDocument.revision,
    experimentDocument.status,
    experimentDocument.successfulRevision,
    runQueue?.minimumStructureRevision,
    runQueue?.setupId,
    runQueue?.stage,
    selectedSampleId,
    selectedSetupId,
    simulation,
    structureDocument.revision,
    structureDocument.status,
    structureDocument.successfulRevision,
  ])

  useEffect(() => {
    if (runQueue?.stage !== 'running' || currentRunSampleId === null) return
    if (!runQueue.runId || simulation.process.runId !== runQueue.runId) return
    if (simulation.process.status === 'failed' || simulation.process.status === 'cancelled') {
      if (runQueue.cancelRequested) {
        setRunQueue((current) => (current?.stage === 'running' ? { ...current, stage: 'complete' } : current))
      } else {
        advanceRunQueue(currentRunSampleId, {
          message:
            simulation.process.error ??
            (simulation.process.status === 'cancelled'
              ? 'Solver 실행이 취소되었습니다.'
              : 'Solver 실행에 실패했습니다.'),
          type: 'failure',
        })
      }
      return
    }
    if (
      simulation.process.status !== 'succeeded' ||
      !simulation.recordedData ||
      !experimentDocument.simulationProgram ||
      simulation.stale ||
      simulation.recordedData === runPreviousRecordedData.current
    )
      return

    const result = simulation.recordedData
    const schemas = experimentDocument.simulationProgram.recordedData
    let recordedData: MeasurementSaveRequest['recorded_data']
    try {
      let recordedByteLength = 0
      recordedData = Object.entries(result).map(([name, data]) => {
        const spec = schemas[name]
        if (!spec) throw new Error(`RecordedData ${JSON.stringify(name)} schema가 없습니다.`)
        const quantityKind = spec.quantityKind
        const { tensorOrder, ...dataSchema } = spec
        const accessor = createDataTensorAccessor(spec, data, `RecordedData ${JSON.stringify(name)}`)
        recordedByteLength += accessor.byteLength
        if (recordedByteLength > MAX_RECORDED_DATA_BYTES) {
          throw new Error(`RecordedData raw bytes exceed the ${MAX_RECORDED_DATA_BYTES / 1024 / 1024} MiB Run limit.`)
        }
        return {
          name,
          quantity_kind: quantityKind ?? null,
          tensor_order: tensorOrder,
          dtype: spec.dtype,
          data_schema: persistDataSchema(dataSchema),
          data: persistDataTensor(spec, data, `RecordedData ${JSON.stringify(name)}`),
        }
      })
    } catch (error) {
      advanceRunQueue(currentRunSampleId, {
        message: error instanceof Error ? error.message : 'RecordedData tensor를 저장 형식으로 변환하지 못했습니다.',
        type: 'failure',
      })
      return
    }
    const request: MeasurementSaveRequest = {
      sample_id: currentRunSampleId,
      setup_id: runQueue.setupId,
      recorded_data: recordedData,
    }
    setHideLiveRecordedData(false)
    setRunQueue((current) =>
      current?.stage === 'running' && current.sampleIds[current.index] === currentRunSampleId
        ? { ...current, stage: 'saving' }
        : current,
    )
    void measurementMutation
      .mutateAsync(request)
      .then(({ id }) =>
        advanceRunQueue(currentRunSampleId, {
          measurementId: id,
          type: 'success',
        }),
      )
      .catch((error: unknown) =>
        advanceRunQueue(currentRunSampleId, {
          message: error instanceof Error ? error.message : 'Measurement를 저장하지 못했습니다.',
          type: 'failure',
        }),
      )
  }, [
    advanceRunQueue,
    currentRunSampleId,
    measurementMutation,
    runQueue?.cancelRequested,
    runQueue?.runId,
    runQueue?.setupId,
    runQueue?.stage,
    simulation.process.error,
    simulation.process.runId,
    simulation.process.status,
    experimentDocument.simulationProgram,
    simulation.recordedData,
    simulation.stale,
  ])

  useEffect(() => {
    if (runQueue?.stage !== 'complete') return
    const completedQueue = runQueue
    setRunQueue(null)

    if (completedQueue.mode === 'batch') {
      setRunSummary({
        cancelled: completedQueue.cancelRequested,
        failures: completedQueue.failures,
        successCount: completedQueue.successes.length,
        total: completedQueue.sampleIds.length,
      })
    }

    const restoreSelection = async () => {
      const lastSuccess = completedQueue.successes[completedQueue.successes.length - 1]
      if (lastSuccess) {
        await loadMeasurement(lastSuccess.measurementId)
        return
      }
      const original = completedQueue.originalSelection
      if (original.measurementId) {
        await loadMeasurement(original.measurementId)
        return
      }
      const [sample, setup] = await Promise.all([
        original.sampleId ? loadSample(original.sampleId, false) : Promise.resolve(null),
        original.setupId ? loadSetup(original.setupId, false) : Promise.resolve(null),
      ])
      updateDeepLink({
        experiment: setup?.experiment_id ?? currentExperimentId ?? null,
        measurement: null,
        sample: sample?.id ?? null,
        setup: setup?.id ?? null,
        structure: sample?.structure_id ?? currentStructureId ?? null,
      })
    }

    void restoreSelection().catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : '실행 후 선택 상태를 복원하지 못했습니다.'),
    )

    if (completedQueue.mode === 'batch') {
      const prefix = completedQueue.cancelRequested ? '일괄 실행을 취소했습니다.' : '일괄 실행을 완료했습니다.'
      const message = `${prefix} 성공 ${completedQueue.successes.length}개, 실패 ${completedQueue.failures.length}개`
      if (completedQueue.failures.length > 0) toast.error(message)
      else toast.success(message)
    } else if (completedQueue.successes.length > 0) {
      toast.success(
        completedQueue.mode === 'generated'
          ? 'Sample과 Measurement를 생성했습니다.'
          : 'Measurement와 Recorded Data를 저장했습니다.',
      )
    } else {
      toast.error(completedQueue.failures[0]?.message ?? 'Measurement 실행을 완료하지 못했습니다.')
    }
  }, [currentExperimentId, currentStructureId, loadMeasurement, loadSample, loadSetup, runQueue, updateDeepLink])

  const persistedRecordedData = useMemo<RecordedData | null>(() => {
    if (!selectedMeasurementId || !recordedDataQuery.data) return null
    return Object.freeze(
      Object.fromEntries(
        recordedDataQuery.data.items
          .filter((row) => row.data !== null && row.data !== undefined)
          .map((row) => [row.name, row.data]),
      ),
    ) as RecordedData
  }, [recordedDataQuery.data, selectedMeasurementId])
  const displayedRecordedData = selectedMeasurementId
    ? persistedRecordedData
    : hideLiveRecordedData
      ? null
      : simulation.recordedData

  const startRealization = (kind: 'sample' | 'setup', runSetupId: number | null = null) => {
    if (!auth.isAuthenticated) {
      navigate('/login', { state: { from: `${location.pathname}${location.search}` } })
      return
    }
    const originalSelection =
      runSetupId === null
        ? null
        : {
            measurementId: selectedMeasurementId,
            sampleId: selectedSampleId,
            setupId: selectedSetupId,
          }
    setSelectedMeasurementId(null)
    updateDeepLink({ measurement: null, [kind]: null })
    const document = kind === 'sample' ? structureDocument : experimentDocument
    if (kind === 'sample') {
      setStructureVars(undefined)
      setStructureMaterialSnapshot(null)
      setSelectedSampleId(null)
    } else {
      setExperimentVars(undefined)
      setExperimentMaterialSnapshot(null)
      setSelectedSetupId(null)
    }
    setPendingRealization({
      kind,
      minimumRevision: document.revision + 1,
      originalSelection,
      runSetupId,
    })
    document.handleReroll()
  }
  const startMeasurement = () => {
    if (!auth.isAuthenticated) {
      navigate('/login', { state: { from: `${location.pathname}${location.search}` } })
      return
    }
    if (!simulation.canRun || !selectedSampleId || !selectedSetupId) return
    startRunQueue([selectedSampleId], selectedSetupId, 'single', true)
  }
  const startBatchMeasurements = () => {
    if (!auth.isAuthenticated || !selectedSetupId || unmeasuredSamples.length === 0) return
    const firstSampleIsLoaded = unmeasuredSamples[0]?.id === selectedSampleId
    startRunQueue(
      unmeasuredSamples.map((sample) => sample.id),
      selectedSetupId,
      'batch',
      firstSampleIsLoaded,
    )
  }
  const cancelBatchMeasurements = () => {
    if (runQueue?.mode !== 'batch') return
    if (runQueue.stage === 'running') {
      simulation.cancel()
      setRunQueue((current) => (current?.mode === 'batch' ? { ...current, cancelRequested: true } : current))
      return
    }
    if (runQueue.stage === 'saving') {
      setRunQueue((current) => (current?.mode === 'batch' ? { ...current, cancelRequested: true } : current))
      return
    }
    if (runQueue.stage === 'load') {
      setRunQueue((current) => (current?.mode === 'batch' ? { ...current, cancelRequested: true } : current))
      return
    }
    setRunQueue((current) =>
      current?.mode === 'batch' ? { ...current, cancelRequested: true, stage: 'complete' } : current,
    )
  }
  const openManager = (kind: 'experiment' | 'structure', mode: 'code' | 'list') => {
    const id = kind === 'structure' ? currentStructureId : currentExperimentId
    const next = new URLSearchParams()
    if (id) next.set(kind, String(id))
    next.set('mode', mode)
    navigate(`/${kind === 'structure' ? 'structures' : 'experiments'}?${next.toString()}`, {
      state: { measurementReturnTo: `${location.pathname}${location.search}` },
    })
  }

  const structureViewerDocument = useMemo(
    () =>
      structure
        ? {
            scene: structureDocument.scene,
            sceneHash: structureDocument.sceneHash,
            variables: structureDocument.variables,
          }
        : null,
    [structure, structureDocument.scene, structureDocument.sceneHash, structureDocument.variables],
  )
  const experimentViewerDocument = useMemo(
    () =>
      experiment
        ? {
            scene: experimentDocument.scene,
            sceneHash: experimentDocument.sceneHash,
            variables: experimentDocument.variables,
          }
        : null,
    [experiment, experimentDocument.scene, experimentDocument.sceneHash, experimentDocument.variables],
  )
  const handleRenderStart = useCallback(
    (sources: readonly CadDocumentType[]) => {
      if (sources.includes('structure')) structureDocument.handleRenderStart()
      if (sources.includes('experiment')) experimentDocument.handleRenderStart()
    },
    [experimentDocument, structureDocument],
  )
  const handleRenderEnd = useCallback(
    (sources: readonly CadDocumentType[]) => {
      if (sources.includes('structure')) structureDocument.handleRenderEnd()
      if (sources.includes('experiment')) experimentDocument.handleRenderEnd()
    },
    [experimentDocument, structureDocument],
  )
  const handleRenderError = useCallback(
    (message: string, sources: readonly CadDocumentType[]) => {
      if (sources.includes('structure')) structureDocument.handleRenderError(message)
      if (sources.includes('experiment')) experimentDocument.handleRenderError(message)
    },
    [experimentDocument, structureDocument],
  )

  const savingRealization = realizationMutation.isPending ? realizationMutation.variables : null
  const savingRealizationKind = savingRealization?.kind ?? null
  const creatingSample = pendingRealization?.kind === 'sample' || savingRealizationKind === 'sample'
  const creatingSampleAndRun =
    (pendingRealization?.kind === 'sample' && pendingRealization.runSetupId !== null) ||
    (savingRealization?.kind === 'sample' && savingRealization.runSetupId !== null) ||
    runQueue?.mode === 'generated'
  const creatingSetup = pendingRealization?.kind === 'setup' || savingRealizationKind === 'setup'
  const measurementBusy =
    runQueue !== null ||
    measurementMutation.isPending ||
    simulation.process.status === 'preparing' ||
    simulation.process.status === 'running'
  const workflowBusy = creatingSample || creatingSetup || measurementBusy
  const deleting = deleteMutation.isPending
  const interactionBusy = selectingDefaults || workflowBusy || deleting
  const deleteTargetId =
    deleteTarget === 'sample'
      ? selectedSampleId
      : deleteTarget === 'setup'
        ? selectedSetupId
        : deleteTarget === 'measurement'
          ? selectedMeasurementId
          : null

  if (auth.isLoading) {
    return (
      <section
        aria-label="Measurement 워크스페이스"
        className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <LoaderCircle className="animate-spin" />
        로그인 상태를 확인하는 중입니다.
      </section>
    )
  }

  return (
    <section
      aria-label="Measurement 워크스페이스"
      className="grid h-full min-h-0 grid-cols-1 overflow-auto lg:grid-cols-[420px_minmax(0,1fr)] lg:overflow-hidden"
    >
      <aside className="min-h-[520px] space-y-3 overflow-auto border-b bg-muted/20 p-3 lg:min-h-0 lg:border-r lg:border-b-0">
        <Card>
          <CardHeader className="space-y-3 pb-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <CardDescription className="flex items-center gap-1.5">
                  <Box className="size-3.5" />
                  현재 Structure
                </CardDescription>
                <CardTitle className="mt-1 truncate text-base">{structureRecord?.name ?? '선택되지 않음'}</CardTitle>
              </div>
              <div className="flex gap-1">
                <Button
                  disabled={interactionBusy}
                  size="sm"
                  variant="outline"
                  onClick={() => openManager('structure', 'list')}
                >
                  선택
                </Button>
                <Button
                  aria-label="현재 Structure 편집"
                  disabled={!currentStructureId || interactionBusy}
                  size="icon"
                  variant="outline"
                  onClick={() => openManager('structure', 'code')}
                >
                  <Pencil />
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                disabled={!currentStructureId || structureDocument.status !== 'Ready' || interactionBusy}
                size="sm"
                variant="secondary"
                onClick={() => startRealization('sample')}
              >
                {creatingSample ? <LoaderCircle className="animate-spin" /> : <Plus />}Sample 생성
              </Button>
              <Button
                disabled={!auth.isAuthenticated || !selectedSampleId || interactionBusy}
                size="sm"
                variant="destructive"
                onClick={() => setDeleteTarget('sample')}
              >
                <Trash2 />
                선택 Sample 삭제
              </Button>
            </div>
            <Button
              className="w-full"
              disabled={
                !currentStructureId ||
                !selectedSetupId ||
                structureDocument.status !== 'Ready' ||
                experimentDocument.status !== 'Ready' ||
                interactionBusy
              }
              size="sm"
              variant="outline"
              onClick={() => {
                if (selectedSetupId) startRealization('sample', selectedSetupId)
              }}
            >
              {creatingSampleAndRun ? <LoaderCircle className="animate-spin" /> : <Play />}
              Sample 생성 + Run
            </Button>
          </CardHeader>
          <CardContent className="h-48 overflow-y-auto border-t pt-3">
            {!auth.isAuthenticated ? (
              <p className="py-3 text-center text-xs text-muted-foreground">로그인하면 Sample을 저장할 수 있습니다.</p>
            ) : samplesQuery.isLoading ? (
              <p className="py-3 text-center text-xs text-muted-foreground">Sample을 불러오는 중입니다.</p>
            ) : samplesQuery.isError ? (
              <p className="py-3 text-center text-xs text-destructive">Sample 목록을 불러오지 못했습니다.</p>
            ) : samples.length === 0 ? (
              <p className="py-3 text-center text-xs text-muted-foreground">현재 Structure의 Sample이 없습니다.</p>
            ) : (
              <div className="flex flex-wrap content-start gap-2">
                {samples.map((sample) => (
                  <button
                    aria-label={`Sample #${sample.id}`}
                    aria-pressed={selectedSampleId === sample.id}
                    className={`size-3 shrink-0 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 ${
                      selectedSampleId === sample.id
                        ? 'bg-primary ring-2 ring-primary/30'
                        : 'bg-muted-foreground/30 hover:bg-muted-foreground/60'
                    }`}
                    disabled={interactionBusy}
                    key={sample.id}
                    type="button"
                    onClick={() =>
                      void loadSample(sample.id).catch((error: unknown) =>
                        toast.error(error instanceof Error ? error.message : 'Sample을 열지 못했습니다.'),
                      )
                    }
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="space-y-3 pb-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <CardDescription className="flex items-center gap-1.5">
                  <FlaskConical className="size-3.5" />
                  현재 Experiment
                </CardDescription>
                <CardTitle className="mt-1 truncate text-base">{experimentRecord?.name ?? '선택되지 않음'}</CardTitle>
              </div>
              <div className="flex gap-1">
                <Button
                  disabled={interactionBusy}
                  size="sm"
                  variant="outline"
                  onClick={() => openManager('experiment', 'list')}
                >
                  선택
                </Button>
                <Button
                  aria-label="현재 Experiment 편집"
                  disabled={!currentExperimentId || interactionBusy}
                  size="icon"
                  variant="outline"
                  onClick={() => openManager('experiment', 'code')}
                >
                  <Pencil />
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                disabled={!currentExperimentId || experimentDocument.status !== 'Ready' || interactionBusy}
                size="sm"
                variant="secondary"
                onClick={() => startRealization('setup')}
              >
                {creatingSetup ? <LoaderCircle className="animate-spin" /> : <Plus />}Setup 생성
              </Button>
              <Button
                disabled={!auth.isAuthenticated || !selectedSetupId || interactionBusy}
                size="sm"
                variant="destructive"
                onClick={() => setDeleteTarget('setup')}
              >
                <Trash2 />
                선택 Setup 삭제
              </Button>
            </div>
          </CardHeader>
          <CardContent className="h-48 overflow-y-auto border-t pt-3">
            {!auth.isAuthenticated ? (
              <p className="py-3 text-center text-xs text-muted-foreground">로그인하면 Setup을 저장할 수 있습니다.</p>
            ) : setupsQuery.isLoading ? (
              <p className="py-3 text-center text-xs text-muted-foreground">Setup을 불러오는 중입니다.</p>
            ) : setupsQuery.isError ? (
              <p className="py-3 text-center text-xs text-destructive">Setup 목록을 불러오지 못했습니다.</p>
            ) : setups.length === 0 ? (
              <p className="py-3 text-center text-xs text-muted-foreground">현재 Experiment의 Setup이 없습니다.</p>
            ) : (
              <div className="flex flex-wrap content-start gap-2">
                {setups.map((setup) => (
                  <button
                    aria-label={`Setup #${setup.id}`}
                    aria-pressed={selectedSetupId === setup.id}
                    className={`size-3 shrink-0 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 ${
                      selectedSetupId === setup.id
                        ? 'bg-primary ring-2 ring-primary/30'
                        : 'bg-muted-foreground/30 hover:bg-muted-foreground/60'
                    }`}
                    disabled={interactionBusy}
                    key={setup.id}
                    type="button"
                    onClick={() =>
                      void loadSetup(setup.id).catch((error: unknown) =>
                        toast.error(error instanceof Error ? error.message : 'Setup을 열지 못했습니다.'),
                      )
                    }
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="space-y-3 pb-3">
            <div>
              <CardDescription className="flex items-center gap-1.5">
                <Activity className="size-3.5" />
                현재 조합
              </CardDescription>
              <CardTitle className="mt-1 text-base">Measurements</CardTitle>
            </div>
            {!auth.isAuthenticated ? (
              <Button
                className="w-full"
                size="sm"
                onClick={() => navigate('/login', { state: { from: `${location.pathname}${location.search}` } })}
              >
                <LogIn />
                로그인
              </Button>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    disabled={!selectedSampleId || !selectedSetupId || !simulation.canRun || interactionBusy}
                    size="sm"
                    onClick={startMeasurement}
                  >
                    {measurementBusy ? <LoaderCircle className="animate-spin" /> : <Play />}Run Measurement
                  </Button>
                  <Button
                    disabled={!selectedMeasurementId || interactionBusy}
                    size="sm"
                    variant="destructive"
                    onClick={() => setDeleteTarget('measurement')}
                  >
                    <Trash2 />
                    선택 Measurement 삭제
                  </Button>
                </div>
                <Button
                  className="w-full"
                  disabled={
                    !currentStructureId ||
                    !selectedSetupId ||
                    samplesQuery.isLoading ||
                    samplesQuery.isError ||
                    measurementsQuery.isLoading ||
                    measurementsQuery.isError ||
                    unmeasuredSamples.length === 0 ||
                    interactionBusy
                  }
                  size="sm"
                  variant="secondary"
                  onClick={startBatchMeasurements}
                >
                  {runQueue?.mode === 'batch' ? <LoaderCircle className="animate-spin" /> : <Rows3 />}
                  미측정 Sample 모두 실행 ({unmeasuredSamples.length})
                </Button>
                <Button
                  className="w-full"
                  disabled={!currentStructureId || !currentExperimentId || interactionBusy}
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    navigate(`/analysis?structure=${currentStructureId}&experiment=${currentExperimentId}`)
                  }
                >
                  <ChartNoAxesCombined />이 조합 분석
                </Button>
                {runQueue?.mode === 'batch' ? (
                  <div className="rounded-md border bg-muted/40 p-2 text-xs" aria-live="polite">
                    <p className="font-medium">
                      Sample #{currentRunSampleId ?? '-'} · {runQueue.successes.length + runQueue.failures.length}/
                      {runQueue.sampleIds.length} 완료
                    </p>
                    <p className="mt-0.5 text-muted-foreground">
                      성공 {runQueue.successes.length} · 실패 {runQueue.failures.length}
                      {runQueue.cancelRequested ? ' · 취소 처리 중' : ''}
                    </p>
                    <p className="mt-0.5 text-muted-foreground">
                      {runQueue.stage === 'load'
                        ? 'Sample 불러오는 중'
                        : runQueue.stage === 'evaluate'
                          ? 'CAD 평가·Solver 호환성 확인 중'
                          : runQueue.stage === 'running'
                            ? 'Solver 실행 중'
                            : runQueue.stage === 'saving'
                              ? 'Measurement 저장 중'
                              : '실행 결과 정리 중'}
                    </p>
                    <Button
                      className="mt-2 w-full"
                      disabled={runQueue.cancelRequested}
                      size="sm"
                      variant="outline"
                      onClick={cancelBatchMeasurements}
                    >
                      일괄 실행 취소
                    </Button>
                  </div>
                ) : runSummary ? (
                  <div className="rounded-md border bg-muted/40 p-2 text-xs" role="status">
                    <p className="font-medium">
                      {runSummary.cancelled ? '일괄 실행 취소됨' : '일괄 실행 완료'} · 성공 {runSummary.successCount} ·
                      실패 {runSummary.failures.length}
                    </p>
                    {runSummary.failures.length > 0 ? (
                      <p className="mt-0.5 text-destructive">
                        실패 Sample: {runSummary.failures.map((failure) => `#${failure.sampleId}`).join(', ')}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
            <p className="text-[11px] leading-4 text-muted-foreground">
              {!selectedSampleId || !selectedSetupId
                ? 'Sample과 Setup을 각각 선택하세요.'
                : simulation.compatibility.status === 'incompatible'
                  ? '현재 조합은 Solver 계약과 호환되지 않습니다.'
                  : measurementBusy
                    ? 'Solver 실행 또는 결과 저장 중입니다.'
                    : '선택된 실현값으로 Solver를 실행하고 결과를 저장합니다.'}
            </p>
          </CardHeader>
          <CardContent className="h-48 overflow-y-auto border-t pt-3">
            {!auth.isAuthenticated ? (
              <p className="py-3 text-center text-xs text-muted-foreground">
                로그인하면 Measurement 이력을 볼 수 있습니다.
              </p>
            ) : measurementsQuery.isLoading ? (
              <p className="py-3 text-center text-xs text-muted-foreground">Measurement를 불러오는 중입니다.</p>
            ) : measurementsQuery.isError ? (
              <p className="py-3 text-center text-xs text-destructive">Measurement 목록을 불러오지 못했습니다.</p>
            ) : measurements.length === 0 ? (
              <p className="py-3 text-center text-xs text-muted-foreground">현재 조합의 Measurement가 없습니다.</p>
            ) : (
              <div className="flex flex-wrap content-start gap-2">
                {measurements.map((measurement) => (
                  <button
                    aria-label={`Measurement #${measurement.id}`}
                    aria-pressed={selectedMeasurementId === measurement.id}
                    className={`size-3 shrink-0 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 ${
                      selectedMeasurementId === measurement.id
                        ? 'bg-primary ring-2 ring-primary/30'
                        : 'bg-muted-foreground/30 hover:bg-muted-foreground/60'
                    }`}
                    disabled={interactionBusy}
                    key={measurement.id}
                    type="button"
                    onClick={() =>
                      void loadMeasurement(measurement.id).catch((error: unknown) =>
                        toast.error(error instanceof Error ? error.message : 'Measurement를 열지 못했습니다.'),
                      )
                    }
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </aside>

      <div className="min-h-[420px] min-w-0 lg:h-full lg:min-h-0">
        <CadViewer
          experiment={experimentViewerDocument}
          recordedData={displayedRecordedData}
          resultsLayout="split"
          structure={structureViewerDocument}
          onRenderEnd={handleRenderEnd}
          onRenderError={handleRenderError}
          onRenderStart={handleRenderStart}
        />
      </div>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && !deleteMutation.isPending && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {deleteTarget === 'sample'
                ? 'Sample을 삭제할까요?'
                : deleteTarget === 'setup'
                  ? 'Setup을 삭제할까요?'
                  : 'Measurement를 삭제할까요?'}
            </DialogTitle>
            <DialogDescription>
              {deleteTarget === 'sample'
                ? '이 Sample과 연결된 모든 Measurement 및 Recorded Data도 함께 삭제됩니다.'
                : deleteTarget === 'setup'
                  ? '이 Setup과 연결된 모든 Measurement 및 Recorded Data도 함께 삭제됩니다.'
                  : '이 Measurement의 Recorded Data도 함께 삭제됩니다. Sample과 Setup은 유지됩니다.'}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border bg-muted/20 p-3 text-sm">
            <span className="font-medium">
              {deleteTarget === 'sample' ? 'Sample' : deleteTarget === 'setup' ? 'Setup' : 'Measurement'}
            </span>
            <span className="ml-2 text-muted-foreground">#{deleteTargetId}</span>
          </div>
          <DialogFooter>
            <Button disabled={deleteMutation.isPending} variant="outline" onClick={() => setDeleteTarget(null)}>
              취소
            </Button>
            <Button
              disabled={deleteMutation.isPending || !deleteTarget || !deleteTargetId}
              variant="destructive"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
            >
              {deleteMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              삭제
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

export const Component = MeasurementPage
