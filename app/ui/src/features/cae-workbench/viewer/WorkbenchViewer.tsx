import { ViewerDiagnostic, ViewerDiagnostics } from '@/features/viewer/viewer/ViewerDiagnostics'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { createViewerSelection, type ViewerSelectionStore } from '@/features/viewer/viewer/viewerSelection'
import { ViewerPlaybackAvailable } from '@/features/viewer/viewer/viewerPlaybackState'
import { useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import { GeometryDisplayManaged, ViewerLayout } from '@/features/viewer/viewer/ViewerTools'
import { ViewerDisplayControls, ViewerResultMenuHost } from '@/features/viewer/viewer/ViewerDisplayControls'
import {
  initialViewerDisplay,
  initializeVisualizations,
  visualizationGroups,
  sameInvocation,
  type GeometryMode,
  type VisualizationSelection,
} from '@/features/viewer/viewer/viewerDisplay'
import {
  combineMeshes,
  SceneLayersContext,
  ViewerSceneLayer,
  ViewerSceneOnly,
  ViewerResultScope,
  type SceneLayer,
} from '@/features/viewer/viewer/ViewerSceneLayers'
import { createComparisonCamera } from '@/features/viewer/viewer/comparisonCamera'
import { cameraPoseSchema, durableViewerSettings, type ViewerDefaults } from '@/contracts/viewerDefaults'
import { ViewerPresentationMenu, type ViewerPresentationActions } from '@/features/experiment/ViewerPresentationMenu'
import {
  createViewerSettings,
  ViewerPersistenceContext,
  ViewerComparisonContext,
  useViewerComparison,
  useViewerSetting,
  ViewerControls,
  type ViewerPersistence,
  type ViewerComparison,
} from '@/features/viewer/viewer/comparisonSettings'
import { BoxGridResult } from '@/features/viewer/viewer/BoxGridResult'
import { calculationExperimentRecordReference } from '@/lib/calculation/dependencies'
import { materialVarsHash } from '@/lib/material/resolution'
import CadViewer from '@/features/viewer/viewer/CadViewer'
import type { MeasurementVisualizations, RecordedResultContracts } from '@/contracts/results'
import { visualizationData } from '@/features/viewer/viewer/visualizationData'
import { parseResultPolylines } from '@/features/viewer/viewer/resultPolylines'
import { ResultTensorView } from '@/features/viewer/viewer/ResultTensorView'
import { experimentTaskName, type ExperimentSourceDocument } from '@/lib/cad/source'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import type { CadViewerSourceLookupStatus } from '@/features/viewer/viewer/selection'
import type { RecordedData, RecordedDataRule, UcumUnit } from '@/lib/cad/model'
import { isDataTensor } from '@/lib/cad/model/dataTensor'
import { parseRecordedMeshFields } from '@/features/viewer/viewer/meshFields'
import { MeshFieldResult } from '@/features/viewer/viewer/MeshFieldResult'
import { parseRecordedMeshTransforms } from '@/features/viewer/viewer/meshTransforms'
import { MeshTransformResult } from '@/features/viewer/viewer/MeshTransformResult'
import { parseRecordedParticleSets } from '@/features/viewer/viewer/particleSets'
import { ParticleSetResult } from '@/features/viewer/viewer/ParticleSetResult'
import { ResizableSplit } from '@/shared/layout/ResizableSplit'

const emptyData = {}
const emptyRules: readonly RecordedDataRule[] = []

export type WorkbenchViewerProps = {
  onActivity?: RuntimeActivityCallback
  selectionStore?: ViewerSelectionStore
  onGeometryRequiredChange?: (required: boolean) => void
  pendingExperimentDocument?: CadDocumentController
  initialDefaults?: ViewerDefaults | null
  presentation?: ViewerPresentationActions
  calculationSource?: string
  activeExperimentTaskName?: string | null
  experiment: ExperimentSourceDocument | null
  experimentDocument: CadDocumentController
  onFindSelectionSource?: (value: string) => void
  onSelectionSourcePathsChange?: (values: readonly string[]) => void
  resultErrors?: Readonly<Record<string, string>>
  resultContracts?: RecordedResultContracts | null
  visualizations?: MeasurementVisualizations
  resultSourceHash?: string | null
  resultVarsHash?: string | null
  selectionSourceStatus?: Readonly<Record<string, CadViewerSourceLookupStatus>>
  recordedData?: RecordedData
  recordedRules?: readonly RecordedDataRule[]
  loading?: boolean
  downloadProgress?: Readonly<{ completed: number; total: number }> | null
  autoSelectResult?: boolean
  captureRef?: Ref<HTMLDivElement>
  selectedResult?: string
  onSelectedResultChange?: (name: string) => void
  comparison?: ViewerComparison
  showToolbar?: boolean
  /** Retain camera, result selection and controls across pending Prediction renders. */
  persistenceKey?: string
  resultPlaceholder?: string
}

export function WorkbenchViewer(props: WorkbenchViewerProps) {
  const [localSelection] = useState(createViewerSelection)
  const selection = props.selectionStore ?? localSelection
  const sessions = useRef(new Map<string, ViewerPersistence>())
  const sessionKey = props.persistenceKey ?? 'default'
  if (!sessions.current.has(sessionKey))
    sessions.current.set(sessionKey, {
      settings: createViewerSettings(props.initialDefaults, selection),
      camera: createComparisonCamera(props.initialDefaults?.camera),
      item: '',
    })
  const session = sessions.current.get(sessionKey)!
  const persistent = useMemo(() => ({ ...session, settings: { ...session.settings, selection } }), [session, selection])
  const previous = useRef<WorkbenchViewerProps | null>(null)
  if (previous.current?.persistenceKey !== props.persistenceKey || previous.current?.experiment !== props.experiment)
    previous.current = null
  if (
    props.persistenceKey &&
    !props.resultPlaceholder &&
    props.recordedData &&
    Object.keys(props.resultContracts ?? {}).length
  )
    previous.current = props
  const pending = props.resultPlaceholder ? previous.current : null
  return (
    <ViewerDiagnostics key={sessionKey} onActivity={props.onActivity}>
      <GeometryDisplayManaged.Provider value>
        <ViewerPersistenceContext.Provider value={persistent}>
          <ViewerComparisonContext.Provider value={props.comparison ?? null}>
            <ViewerContent
              key={sessionKey}
              {...props}
              pendingExperimentDocument={pending?.experimentDocument}
              recordedData={pending?.recordedData ?? props.recordedData}
              recordedRules={pending?.recordedRules ?? props.recordedRules}
              resultContracts={pending?.resultContracts ?? props.resultContracts}
              visualizations={pending?.visualizations ?? props.visualizations}
              resultSourceHash={pending?.resultSourceHash ?? props.resultSourceHash}
              resultVarsHash={pending?.resultVarsHash ?? props.resultVarsHash}
            />
          </ViewerComparisonContext.Provider>
        </ViewerPersistenceContext.Provider>
      </GeometryDisplayManaged.Provider>
    </ViewerDiagnostics>
  )
}

function ViewerContent(props: WorkbenchViewerProps) {
  const { resultPlaceholder, loading, resultSourceHash, resultVarsHash, onGeometryRequiredChange } = props
  const initialDefaults = useRef(props.initialDefaults).current
  const comparison = useViewerComparison()
  const persistent = useContext(ViewerPersistenceContext)!
  const sharedResultHosts = useContext(ViewerResultMenuHost)
  const [localResultHosts, updateResultHosts] = useState<Record<string, HTMLElement>>({})
  const setResultHost = useCallback(
    (name: string, host: HTMLDivElement | null) =>
      updateResultHosts((current) => {
        if ((current[name] ?? null) === host) return current
        const next = { ...current }
        if (host) next[name] = host
        else delete next[name]
        return next
      }),
    [],
  )
  const capture = useRef<HTMLDivElement>(null)
  useImperativeHandle(props.captureRef, () => capture.current!)
  const visual = useMemo(() => visualizationData(props.visualizations ?? emptyData), [props.visualizations])
  const contracts = useMemo(() => ({ ...props.resultContracts, ...visual.contracts }), [props.resultContracts, visual])
  const data = useMemo(() => ({ ...props.recordedData, ...visual.data }), [props.recordedData, visual])
  const rules = useMemo(() => [...(props.recordedRules ?? emptyRules), ...visual.rules], [props.recordedRules, visual])
  const errors = useMemo(() => ({ ...props.resultErrors, ...visual.errors }), [props.resultErrors, visual])
  const initial = useRef(initialViewerDisplay(initialDefaults))
  const [localOutput, setOutput] = useViewerSetting('selectedOutput', initial.current.output, 'workspace')
  const output = props.selectedResult ?? localOutput
  const [geometry, setGeometry] = useViewerSetting<GeometryMode>('geometryMode', initial.current.geometry, 'workspace')
  const [visualizations, setVisualizations] = useViewerSetting<VisualizationSelection>(
    'visualizations',
    initial.current.visualizations,
    'workspace',
  )
  const document =
    output || Object.values(visualizations).some(Boolean)
      ? (props.pendingExperimentDocument ?? props.experimentDocument)
      : props.experimentDocument
  const selectionMade = useRef(
    persistent.settings.values.get('@workspace:outputInitialized') === true ||
      (Boolean(initialDefaults) && (initialDefaults?.version === 2 || initial.current.output === '')),
  )
  const mesh = useMemo(() => parseRecordedMeshFields(rules, data, contracts), [rules, data, contracts])
  const lines = useMemo(() => parseResultPolylines(contracts, rules, data), [contracts, rules, data])
  const motions = useMemo(() => parseRecordedMeshTransforms(rules, data, contracts), [rules, data, contracts])
  const particles = useMemo(() => parseRecordedParticleSets(rules, data, contracts), [rules, data, contracts])
  const validContracts = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(contracts).filter(([name, contract]) => {
          if (errors[name]) return false
          switch (contract.visualization.kind) {
            case 'mesh-field':
              return mesh.fields.some((field) => field.label === name)
            case 'mesh-transform':
              return motions.motions.some((motion) => motion.label === name)
            case 'particle-set':
              return particles.particles.some((value) => value.label === name)
            case 'polyline':
              return lines.bundles.some((line) => line.id === name)
            default:
              return Object.keys(data).some((key) => key === name || key.startsWith(`${name}.`))
          }
        }),
      ),
    [contracts, errors, mesh, motions, particles, lines, data],
  )
  useEffect(() => {
    if (loading || resultPlaceholder) return
    const next = initializeVisualizations(validContracts, visualizations, initialDefaults)
    if (JSON.stringify(next) !== JSON.stringify(visualizations)) setVisualizations(next)
  }, [validContracts, visualizations, initialDefaults, loading, resultPlaceholder, setVisualizations])
  const snapshot = document.evaluatedSnapshot
  const frameReason =
    !snapshot || !document.scene
      ? 'Geometry가 준비되지 않았습니다.'
      : !resultSourceHash || !resultVarsHash
        ? '결과의 source/Vars 비교 정보가 없어 Geometry를 겹칠 수 없습니다.'
        : snapshot.sourceHash !== resultSourceHash
          ? 'Geometry와 결과의 source가 다릅니다.'
          : materialVarsHash(snapshot.variables) !== resultVarsHash
            ? 'Geometry와 결과의 Vars가 다릅니다.'
            : undefined
  useEffect(() => {
    if (
      props.selectedResult !== undefined ||
      !props.autoSelectResult ||
      selectionMade.current ||
      loading ||
      resultPlaceholder
    )
      return
    const candidates = Object.entries(validContracts).filter(([name]) => !name.startsWith('@visualizations.'))
    if (!candidates.length) return
    let largest = ''
    let count = 0
    for (const [name, contract] of candidates) {
      const tensor = data[name]
      const grid = isDataTensor(tensor) ? tensor.boxGrid?.gridShape : undefined
      if (
        contract.visualization.kind !== 'box-grid' ||
        !grid ||
        !isDataTensor(tensor) ||
        grid.length !== 3 ||
        grid.some((size, axis) => !Number.isSafeInteger(size) || size <= 0 || size !== tensor.shape[axis])
      )
        continue
      const size = grid.reduce((total, length) => total * length, 1)
      if (size > count) {
        largest = name
        count = size
      }
    }
    const spatial = candidates.filter(
      ([, contract]) =>
        !frameReason &&
        (contract.visualization.kind === 'box-grid' || contract.visualization.coordinateSpace === 'experiment'),
    )
    setOutput(
      (initial.current.output && validContracts[initial.current.output] ? initial.current.output : '') ||
        largest ||
        (spatial.length ? spatial[Math.floor(Math.random() * spatial.length)] : candidates[candidates.length - 1])[0],
    )
    selectionMade.current = true
    persistent.settings.set('@workspace:outputInitialized', true)
  }, [
    props.selectedResult,
    props.autoSelectResult,
    loading,
    resultPlaceholder,
    validContracts,
    data,
    frameReason,
    persistent.settings,
    setOutput,
  ])
  const selected = useMemo(() => {
    const kinds = [...new Set([...Object.keys(visualizationGroups(contracts)), ...Object.keys(visualizations)])]
    return [output, ...kinds.map((kind) => visualizations[kind])].filter(
      (name, index, names) => name && names.indexOf(name) === index,
    )
  }, [output, visualizations, contracts])
  const spatialNames = selected
  const provenance = useMemo(
    () =>
      Object.fromEntries(
        Object.keys(contracts).map((name) => {
          const tensor = data[name] ?? Object.entries(data).find(([key]) => key.startsWith(`${name}.`))?.[1]
          return [name, visual.provenance[name] ?? (isDataTensor(tensor) ? tensor.provenance : undefined)]
        }),
      ),
    [contracts, data, visual],
  )
  const { accepted, blocked } = useMemo(() => {
    const accepted: string[] = []
    const blocked: Record<string, string> = {}
    for (const name of spatialNames) {
      if (!validContracts[name]) continue
      if (frameReason) {
        blocked[name] = frameReason
        continue
      }
      if (name === output && contracts[name].visualization.kind !== 'box-grid') {
        blocked[name] = '이 Output은 XYZ point cloud 또는 공간 Heatmap으로 표시할 수 없습니다. 아래 차트를 확인하세요.'
        continue
      }
      if (
        contracts[name].visualization.kind !== 'box-grid' &&
        contracts[name].visualization.coordinateSpace !== 'experiment'
      ) {
        blocked[name] = 'Geometry와 좌표계가 달라 함께 표시할 수 없습니다.'
        continue
      }
      const reference = accepted[0]
      if (reference) {
        const coordinates = (key: string) =>
          contracts[key].visualization.kind === 'box-grid' ||
          contracts[key].visualization.coordinateSpace === 'experiment'
        if (!coordinates(reference) || !coordinates(name) || !sameInvocation(provenance[reference], provenance[name])) {
          blocked[name] = '표시 기준 데이터와 좌표계 또는 실행 이력이 달라 함께 표시할 수 없습니다.'
          continue
        }
      }
      accepted.push(name)
    }
    return { accepted, blocked }
  }, [spatialNames, validContracts, contracts, provenance, frameReason, output])
  const primary = accepted[0]
  const primaryUnit =
    mesh.fields.find((field) => field.label === primary)?.lengthUnit ??
    motions.motions.find((motion) => motion.label === primary)?.lengthUnit ??
    particles.particles.find((value) => value.label === primary)?.lengthUnit
  const displayUnit = (document.scene?.lengthUnit ?? primaryUnit ?? 'm') as UcumUnit
  const [layers, setLayers] = useState<Record<string, SceneLayer>>({})
  const publish = useCallback(
    (name: string, layer: SceneLayer | null) =>
      setLayers((current) => {
        if (layer === null) {
          if (!current[name]) return current
          const next = { ...current }
          delete next[name]
          return next
        }
        const old = current[name]
        if (
          old?.mesh === layer.mesh &&
          old?.heatmap === layer.heatmap &&
          old?.lines === layer.lines &&
          old?.deformed === layer.deformed
        )
          return current
        return { ...current, [name]: layer }
      }),
    [],
  )
  const activeLayers = accepted.flatMap((name) => (layers[name] ? [layers[name]] : []))
  const deformed = activeLayers.some((layer) => layer.deformed)
  const combined = useMemo(
    () => combineMeshes(accepted.flatMap((name) => (layers[name] ? [layers[name]] : []))),
    [layers, accepted],
  )
  const displayedLines = useMemo(
    () => (deformed ? [] : accepted.flatMap((name) => layers[name]?.lines ?? [])),
    [layers, deformed, accepted],
  )
  const heatmaps = useMemo(
    () => accepted.flatMap((name) => (layers[name]?.heatmap ? [layers[name].heatmap!] : [])),
    [accepted, layers],
  )
  const availableSources = document.predictionCandidate?.geometrySources
  useEffect(() => {
    onGeometryRequiredChange?.(true)
    return () => onGeometryRequiredChange?.(false)
  }, [onGeometryRequiredChange])
  const result = (name: string, role?: 'space' | 'chart') => (
    <ViewerResultScope
      key={`${name}:${role ?? 'visualization'}`}
      name={name}
      scope={role ? `${name}@output-${role}` : name}
      available={Boolean(validContracts[name])}
    >
      <RetainedResultLayer
        name={name}
        contracts={contracts}
        data={data}
        rules={rules}
        errors={errors}
        blocked={role === 'chart' ? undefined : blocked[name]}
        role={role}
        displayUnit={displayUnit}
        mesh={mesh}
        lines={lines}
        motions={motions}
        particles={particles}
        calculationSource={props.calculationSource}
        provenance={provenance}
      />
    </ViewerResultScope>
  )
  const scene = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 overflow-auto" data-viewer-scene-results>
        <ViewerSceneOnly.Provider value={true}>
          {spatialNames
            .filter((name) => name !== output || !contracts[name] || contracts[name].visualization.kind === 'box-grid')
            .map((name) => result(name, name === output ? 'space' : undefined))}
        </ViewerSceneOnly.Provider>
      </div>
      <div className="min-h-0 flex-1">
        <CadViewer
          experiment={
            props.experiment
              ? {
                  scene: document.scene,
                  sceneHash: document.sceneHash,
                  taskScenes: document.taskScenes,
                  taskSceneHashes: document.taskSceneHashes,
                }
              : null
          }
          availableSources={props.onGeometryRequiredChange ? availableSources : undefined}
          activeExperimentTaskName={
            props.activeExperimentTaskName ? experimentTaskName(props.activeExperimentTaskName) : null
          }
          geometryOpacity={geometry}
          displayUnit={displayUnit}
          meshRenderData={combined}
          heatmapRenderLayers={heatmaps}
          meshIdentity={accepted.join('|')}
          polylines={displayedLines}
          preserveCameraOnUpdate
          onFindSelectionSource={props.onFindSelectionSource}
          onRenderEnd={document.handleRenderEnd}
          onRenderStart={document.handleRenderStart}
          onRenderError={document.handleRenderError}
          onSelectionSourcePathsChange={props.onSelectionSourcePathsChange}
          selectionSourceStatus={props.selectionSourceStatus}
        />
      </div>
    </div>
  )
  return (
    <ViewerResultMenuHost.Provider value={{ ...sharedResultHosts, ...localResultHosts }}>
      <SceneLayersContext.Provider value={publish}>
        <ViewerLayout>
          {props.presentation ? (
            <ViewerControls placement="presentation">
              <ViewerPresentationMenu
                actions={props.presentation}
                disabled={loading || Boolean(resultPlaceholder)}
                captureNode={() => capture.current}
                snapshot={() => {
                  const owner = comparison ?? persistent
                  const camera = cameraPoseSchema.safeParse(owner.camera.current)
                  return {
                    version: 2,
                    geometryMode: geometry,
                    selectedOutput: output,
                    visualizations,
                    settings: durableViewerSettings(owner.settings.values.entries()),
                    camera: camera.success ? camera.data : null,
                  }
                }}
              />
            </ViewerControls>
          ) : null}
          {props.showToolbar !== false ? (
            <ViewerControls placement="data">
              <ViewerDisplayControls
                contracts={contracts}
                output={output}
                onOutput={(name) => {
                  selectionMade.current = true
                  persistent.settings.set('@workspace:outputInitialized', true)
                  setOutput(name)
                  props.onSelectedResultChange?.(name)
                }}
                geometry={geometry}
                onGeometry={setGeometry}
                visualizations={visualizations}
                onVisualizations={setVisualizations}
                resultHost={setResultHost}
              />
            </ViewerControls>
          ) : null}
          <div className="flex h-full min-h-0 flex-col">
            <ViewerDiagnostic message={document.geometryError} result="Geometry" />
            <div ref={capture} className="min-h-0 flex-1 overflow-hidden">
              <ResizableSplit
                vertical
                label="3D와 Output 높이 조절"
                first={scene}
                second={output ? result(output, 'chart') : null}
              />
            </div>
            {Object.entries(errors)
              .filter(([name]) => !selected.includes(name))
              .map(([name, error]) => (
                <ViewerDiagnostic key={name} result={name} message={error} />
              ))}
          </div>
        </ViewerLayout>
      </SceneLayersContext.Provider>
    </ViewerResultMenuHost.Provider>
  )
}

function RetainedResultLayer(props: Parameters<typeof ResultLayer>[0]) {
  const sceneOnly = useContext(ViewerSceneOnly)
  const previous = useRef<typeof props | null>(null)
  const present =
    Boolean(props.contracts[props.name]) &&
    (Object.keys(props.data).some((key) => key === props.name || key.startsWith(`${props.name}.`)) ||
      props.mesh.fields.some((field) => field.label === props.name))
  const unavailable = !present || Boolean(props.errors[props.name])
  if (!unavailable) previous.current = props
  return (
    <ViewerPlaybackAvailable.Provider value={!unavailable}>
      <ViewerDiagnostic result={props.name} message={props.errors[props.name]} />
      <div className={unavailable ? 'hidden' : sceneOnly ? 'contents' : 'h-full min-h-0'}>
        {unavailable ? previous.current ? <ResultLayer {...previous.current} /> : null : <ResultLayer {...props} />}
      </div>
    </ViewerPlaybackAvailable.Provider>
  )
}

function ResultLayer({
  name,
  contracts,
  data,
  rules,
  errors,
  blocked,
  displayUnit,
  mesh,
  lines,
  motions,
  particles,
  calculationSource,
  provenance,
  role,
}: {
  name: string
  contracts: RecordedResultContracts
  data: RecordedData
  rules: readonly RecordedDataRule[]
  errors: Readonly<Record<string, string>>
  blocked?: string
  displayUnit: UcumUnit
  mesh: ReturnType<typeof parseRecordedMeshFields>
  lines: ReturnType<typeof parseResultPolylines>
  motions: ReturnType<typeof parseRecordedMeshTransforms>
  particles: ReturnType<typeof parseRecordedParticleSets>
  calculationSource?: string
  provenance: Record<string, unknown>
  role?: 'space' | 'chart'
}) {
  // Keep asynchronous Output calculations stable when an unrelated visualization changes.
  const input = useRef<{ rules: readonly RecordedDataRule[]; data: RecordedData } | null>(null)
  const ownRules = rules.filter((rule) => rule.label === name || rule.label.startsWith(`${name}.`))
  const ownData = Object.fromEntries(Object.entries(data).filter(([key]) => key === name || key.startsWith(`${name}.`)))
  if (
    !input.current ||
    ownRules.length !== input.current.rules.length ||
    ownRules.some((rule, index) => rule !== input.current!.rules[index]) ||
    Object.keys(ownData).length !== Object.keys(input.current.data).length ||
    Object.entries(ownData).some(([key, value]) => value !== input.current!.data[key])
  )
    input.current = { rules: ownRules, data: ownData }
  const contract = contracts[name]
  const field = mesh.fields.find((value) => value.label === name)
  const displacementFields = useMemo(
    () =>
      mesh.fields.filter(
        (candidate) => candidate.label === name || sameInvocation(provenance[name], provenance[candidate.label]),
      ),
    [mesh.fields, name, provenance],
  )
  const motion = motions.motions.find((value) => value.label === name)
  const particle = particles.particles.find((value) => value.label === name)
  const selectedLines = useMemo(() => lines.bundles.filter((value) => value.id === name), [lines, name])
  const recordReference = useMemo(() => {
    if (!calculationSource) return undefined
    try {
      return calculationExperimentRecordReference(calculationSource, name)
    } catch {
      return undefined
    }
  }, [calculationSource, name])
  const parseError = [...mesh.errors, ...motions.errors, ...particles.errors, ...lines.errors].find(
    (error) => error.label === name,
  )?.message
  if (blocked) return <ViewerDiagnostic result={name} level="warning" message={blocked} />
  if (errors[name] || parseError) return <ViewerDiagnostic result={name} message={errors[name] ?? parseError} />
  if (
    !contract ||
    (!field &&
      !motion &&
      !particle &&
      !selectedLines.length &&
      !Object.keys(data).some((key) => key === name || key.startsWith(`${name}.`)))
  )
    return null
  if (role === 'chart' && contract.visualization.kind !== 'box-grid')
    return (
      <ResultTensorView
        name={name}
        contract={contract}
        rules={input.current.rules}
        data={input.current.data}
        role={role}
      />
    )
  if (field)
    return (
      <MeshFieldResult
        field={field}
        displacementFields={displacementFields}
        displayUnit={displayUnit}
        renderViewer={(value, view) => (
          <ViewerSceneLayer name={name} mesh={value} deformed={view.deformationScale > 0} />
        )}
      />
    )
  if (motion)
    return (
      <MeshTransformResult
        motion={motion}
        displayUnit={displayUnit}
        renderViewer={(value) => <ViewerSceneLayer name={name} mesh={value} />}
      />
    )
  if (particle)
    return (
      <ParticleSetResult
        particles={particle}
        displayUnit={displayUnit}
        canOverlayGeometry
        renderViewer={(value) => <ViewerSceneLayer name={name} mesh={value} />}
      />
    )
  if (contract.visualization.kind === 'polyline') return <ViewerSceneLayer name={name} lines={selectedLines} />
  if (contract.visualization.kind === 'box-grid')
    return (
      <BoxGridResult
        role={role}
        name={name}
        rules={input.current.rules}
        data={input.current.data}
        displayUnit={displayUnit}
        canOverlayGeometry
        recordReference={recordReference}
        renderViewer={(value) => <ViewerSceneLayer name={name} heatmap={value} />}
      />
    )
  return <ResultTensorView name={name} contract={contract} rules={input.current.rules} data={input.current.data} />
}
