import { useViewerComparison, useViewerSetting, ViewerControls } from './comparisonSettings'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  automaticDeformationScale,
  matchMeshDisplacement,
  meshHistoryBounds,
  meshHistoryRange,
  meshHarmonicAtPhase,
  meshHarmonicBounds,
  meshHarmonicRange,
} from './meshDeformation'
import { MeshPlayback } from './MeshPlayback'
import JscadViewer from './JscadViewer'
import { createMeshFieldRenderData, meshMaterialColors, type MeshFieldView, type RecordedMeshField } from './meshFields'
import type { JscadViewerLayer } from './model'

const noFields: readonly RecordedMeshField[] = Object.freeze([])
const noLayers: readonly JscadViewerLayer[] = Object.freeze([])

export function MeshFieldResult({
  field,
  displacementFields = noFields,
  onRendered,
  renderViewer,
  displayUnit = field.lengthUnit,
}: {
  field: RecordedMeshField
  displacementFields?: readonly RecordedMeshField[]
  onRendered?: () => void
  displayUnit?: typeof field.lengthUnit
  renderViewer?: (data: ReturnType<typeof createMeshFieldRenderData>, view: MeshFieldView) => ReactNode
}) {
  const comparison = useViewerComparison()
  const [view, setView] = useViewerSetting<MeshFieldView>('mesh.view', {
    component: field.valueKind === 'stress' ? 'vonMises' : 'magnitude',
    wireframe: true,
    overlays: true,
    clipAxis: -1,
    clipFraction: 0.5,
    deformationScale: 0,
  })
  const candidates = useMemo(
    () =>
      field.valueKind === 'stress'
        ? displacementFields.flatMap((candidate) => {
            const matched = matchMeshDisplacement(field, candidate)
            return matched ? [matched] : []
          })
        : [],
    [field, displacementFields],
  )
  const [selectedDisplacement, setSelectedDisplacement] = useViewerSetting<string | null>(
    'mesh.selectedDisplacement',
    null,
  )
  const displacement =
    field.valueKind === 'displacement'
      ? field
      : selectedDisplacement !== null
        ? candidates.find((candidate) => candidate.label === selectedDisplacement)
        : candidates.length === 1
          ? candidates[0]
          : undefined
  const [deformed, setDeformed] = useViewerSetting('mesh.deformed', true)
  const [scaleMode, setScaleMode] = useViewerSetting('mesh.scaleMode', 'auto')
  const [manualScale, setManualScale] = useViewerSetting('mesh.manualScale', 1)
  const [frequencyHz, setFrequencyHz] = useViewerSetting('mesh.frequencyHz', field.spectrum?.frequencies[0] ?? 0)
  const [phaseDegrees, setPhaseDegrees] = useViewerSetting('mesh.phaseDegrees', 0)
  const [frameIndex, setFrame] = useViewerSetting('mesh.frameIndex', 0)
  const frame = comparison ? frameIndex : Math.min(frameIndex, Math.max(0, (field.times?.length ?? 1) - 1))
  useEffect(() => {
    if (comparison) return
    setFrame(frame)
    setView((current) =>
      typeof current.component === 'number' && current.component >= field.componentCount
        ? { ...current, component: 'magnitude' }
        : current,
    )
  }, [field, frame, comparison, setFrame, setView])
  const canDeform = Boolean(displacement?.location === 'node' && displacement.componentCount === 3)
  const invalidSetting =
    field.spectrum &&
    (!field.spectrum.frequencies.includes(frequencyHz) ||
      (displacement?.spectrum && !displacement.spectrum.frequencies.includes(frequencyHz)))
      ? `선택한 주파수 ${frequencyHz} Hz가 결과 또는 변위 결과에 없습니다. 보간 없이 공통 주파수를 선택하세요.`
      : field.spectrum && (!Number.isFinite(phaseDegrees) || phaseDegrees < 0 || phaseDegrees > 360)
        ? '표시 위상은 0°부터 360°까지여야 합니다.'
        : comparison &&
            (!Number.isInteger(frame) ||
              frame < 0 ||
              frame >= (field.times?.length ?? 1) ||
              (typeof view.component === 'number' && (view.component < 0 || view.component >= field.componentCount)) ||
              (view.component === 'vonMises' && field.valueKind !== 'stress') ||
              (selectedDisplacement && !displacement))
          ? '저장된 성분·프레임·변위 설정을 현재 데이터에 적용할 수 없습니다. 공통 툴바에서 수정하세요.'
          : ''
  const autoScale = useMemo(
    () => (displacement && !invalidSetting ? automaticDeformationScale(displacement, frequencyHz) : 1),
    [displacement, frequencyHz, invalidSetting],
  )
  const deformationScale =
    canDeform && deformed ? (scaleMode === 'auto' ? autoScale : scaleMode === 'actual' ? 1 : manualScale) : 0
  const currentField = useMemo(
    () =>
      field.spectrum && !invalidSetting
        ? meshHarmonicAtPhase(field, frequencyHz, phaseDegrees)
        : field.historyValues
          ? {
              ...field,
              values: field.historyValues.subarray(frame * field.points.length, (frame + 1) * field.points.length),
            }
          : field,
    [field, frame, frequencyHz, phaseDegrees, invalidSetting],
  )
  const frameDisplacement = useMemo(
    () =>
      displacement === field
        ? currentField
        : displacement?.spectrum && !invalidSetting
          ? meshHarmonicAtPhase(displacement, frequencyHz, phaseDegrees)
          : displacement,
    [displacement, field, currentField, frequencyHz, phaseDegrees, invalidSetting],
  )
  const range = useMemo(
    () =>
      !invalidSetting
        ? field.spectrum
          ? meshHarmonicRange(field, frequencyHz, view.component)
          : field.times
            ? meshHistoryRange(field, view.component)
            : undefined
        : undefined,
    [field, view.component, frequencyHz, invalidSetting],
  )
  const animationBounds = useMemo(
    () =>
      field.spectrum && !invalidSetting
        ? meshHarmonicBounds(displacement ?? field, frequencyHz, deformationScale, displayUnit)
        : field.times
          ? meshHistoryBounds(field, deformationScale, displayUnit)
          : undefined,
    [field, displacement, frequencyHz, deformationScale, displayUnit, invalidSetting],
  )
  const animationTopology = useMemo(
    () =>
      field.times && view.clipAxis < 0 && !invalidSetting
        ? createMeshFieldRenderData(field, { ...view, deformationScale }, displayUnit).geometries
        : undefined,
    [field, view, deformationScale, displayUnit, invalidSetting],
  )
  const effectiveView = { ...view, deformationScale, referenceClip: Boolean(field.spectrum) }
  const [error, setError] = useState<string | null>(null)
  const rendered = useMemo(() => {
    try {
      if (invalidSetting) throw new Error(invalidSetting)
      const data = createMeshFieldRenderData(
        currentField,
        { ...view, deformationScale, referenceClip: Boolean(field.spectrum) },
        displayUnit,
        frameDisplacement,
        range,
        animationTopology,
      )
      if (animationBounds) data.bounds = animationBounds
      return { data, error: null }
    } catch (error) {
      return { data: null, error: error instanceof Error ? error.message : String(error) }
    }
  }, [
    currentField,
    view,
    deformationScale,
    displayUnit,
    frameDisplacement,
    range,
    animationBounds,
    animationTopology,
    invalidSetting,
    field.spectrum,
  ])
  const onRender = useCallback(() => {}, [])
  const component =
    typeof view.component === 'number'
      ? field.components[view.component]
      : view.component === 'magnitude' && field.componentCount === 1
        ? 'Value'
        : view.component
  return (
    <article
      className="flex h-full min-h-0 flex-col overflow-hidden bg-white"
      data-result-visualization="mesh field"
      aria-label={`${field.label} mesh field`}
    >
      <h3 className="px-2 pt-2 text-sm font-semibold text-slate-900">{field.label}</h3>
      <p className="px-2 text-xs text-slate-500">
        {(field.points.length / 3).toLocaleString()} nodes ·{' '}
        {(field.cells.length / (field.cellType === 'tri3' ? 3 : 4)).toLocaleString()}{' '}
        {field.cellType === 'tri3' ? 'triangles' : 'tetrahedra'} · {field.location} values · coordinates{' '}
        {field.lengthUnit}
        {field.configuration ? ` · ${field.configuration === 'reference' ? '기준 배치' : '현재 배치'}` : ''}
        {field.weighting === 'reference-volume' ? ' · 기준 체적 가중 평균' : ''}
        {field.signConvention === 'compression-positive' ? ' · 압축 양수' : ''}
        {field.snapshotTime !== undefined ? ` · time ${field.snapshotTime} ${field.snapshotTimeUnit ?? 's'}` : ''}
      </p>
      <ViewerControls>
        <details
          open
          className="max-h-[40%] shrink-0 overflow-auto border-b [&_select]:min-h-8 [&_select]:rounded [&_select]:border [&_select]:bg-white [&_select]:px-2"
        >
          <summary className="cursor-pointer px-2 py-1 text-sm font-semibold">시각화 · 성분 / 단면 / 변형 설정</summary>
          <div className="flex flex-wrap items-center gap-3 p-2 text-sm text-slate-700">
            {field.spectrum ? (
              <>
                <label>
                  주파수{' '}
                  <select
                    aria-label={`${field.label} frequency`}
                    value={frequencyHz}
                    onChange={(event) => setFrequencyHz(Number(event.target.value))}
                  >
                    {!field.spectrum.frequencies.includes(frequencyHz) ? (
                      <option value={frequencyHz}>{frequencyHz} Hz · 결과 없음</option>
                    ) : null}
                    {Array.from(field.spectrum.frequencies, (frequency) => (
                      <option key={frequency} value={frequency}>
                        {frequency} Hz
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  위상{' '}
                  <input
                    aria-label={`${field.label} phase`}
                    type="range"
                    min={0}
                    max={360}
                    step={1}
                    value={phaseDegrees}
                    onChange={(event) => setPhaseDegrees(Number(event.target.value))}
                  />
                </label>
                <input
                  aria-label={`${field.label} phase degrees`}
                  className="w-20 rounded border p-1"
                  type="number"
                  min={0}
                  max={360}
                  step="any"
                  value={phaseDegrees}
                  onChange={(event) => setPhaseDegrees(Number(event.target.value))}
                />
                <span>
                  {frequencyHz} Hz · {phaseDegrees}° · 순간값 Re(Q exp(iφ)) · peak phasor
                </span>
              </>
            ) : null}
            <label>
              성분{' '}
              <select
                aria-label={`${field.label} field component`}
                className="rounded border p-1"
                value={String(view.component)}
                onChange={(event) =>
                  setView({
                    ...view,
                    component: /^\d+$/u.test(event.target.value)
                      ? Number(event.target.value)
                      : (event.target.value as MeshFieldView['component']),
                  })
                }
              >
                <option value="magnitude">{field.componentCount === 1 ? 'Value' : 'Magnitude'}</option>
                {field.valueKind === 'stress' ? <option value="vonMises">von Mises</option> : null}
                {field.components.map((name, index) => (
                  <option key={index} value={index}>
                    {name}
                  </option>
                ))}
                <option value="material">Material regions</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={view.wireframe}
                onChange={(event) => setView({ ...view, wireframe: event.target.checked })}
              />{' '}
              Mesh 경계선
            </label>
            <label>
              <input
                type="checkbox"
                checked={view.overlays}
                onChange={(event) => setView({ ...view, overlays: event.target.checked })}
              />{' '}
              구속 / 하중
            </label>
            <label>
              단면{' '}
              <select
                aria-label={`${field.label} section axis`}
                className="rounded border p-1"
                value={view.clipAxis}
                onChange={(event) =>
                  setView({ ...view, clipAxis: Number(event.target.value) as MeshFieldView['clipAxis'] })
                }
              >
                <option value={-1}>None</option>
                <option value={0}>X</option>
                <option value={1}>Y</option>
                <option value={2}>Z</option>
              </select>
            </label>
            {view.clipAxis >= 0 ? (
              <label className="flex items-center gap-2">
                Position{' '}
                <input
                  aria-label={`${field.label} section position`}
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={view.clipFraction}
                  onChange={(event) => setView({ ...view, clipFraction: Number(event.target.value) })}
                />
                {rendered.data?.cut.toPrecision(4)} {field.lengthUnit}
              </label>
            ) : null}
            {field.valueKind === 'stress' ? (
              <label>
                변위 결과{' '}
                <select
                  aria-label="Deformation result"
                  value={displacement?.label ?? ''}
                  onChange={(event) => setSelectedDisplacement(event.target.value)}
                >
                  <option value="">{candidates.length ? '선택 안 함' : '호환되는 변위 없음'}</option>
                  {candidates.map((candidate) => (
                    <option key={candidate.label} value={candidate.label}>
                      {candidate.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {canDeform ? (
              <>
                <label>
                  형상{' '}
                  <select
                    value={deformed ? 'deformed' : 'original'}
                    onChange={(event) => setDeformed(event.target.value === 'deformed')}
                  >
                    <option value="original">원형</option>
                    <option value="deformed">변형</option>
                  </select>
                </label>
                <label>
                  변형 배율{' '}
                  <select value={scaleMode} onChange={(event) => setScaleMode(event.target.value)}>
                    <option value="auto">자동 확대</option>
                    <option value="actual">실제 크기 1×</option>
                    <option value="manual">직접 입력</option>
                  </select>
                </label>
                {scaleMode === 'manual' ? (
                  <input
                    aria-label={`${field.label} displacement scale`}
                    className="w-20 rounded border p-1"
                    type="number"
                    min={0}
                    step="any"
                    value={manualScale}
                    onChange={(event) => {
                      const value = Number(event.target.value)
                      if (Number.isFinite(value) && value >= 0) setManualScale(value)
                    }}
                  />
                ) : null}
                <strong>표시 배율 {deformationScale.toPrecision(4)}×</strong>
                <label>
                  <input
                    type="checkbox"
                    checked={view.compareOriginal ?? false}
                    onChange={(event) => setView({ ...view, compareOriginal: event.target.checked })}
                  />{' '}
                  원형 윤곽 비교
                </label>
              </>
            ) : null}
          </div>
        </details>
        {field.times ? (
          <MeshPlayback times={field.times} unit={field.timeUnit!} frame={frame} onFrame={setFrame} />
        ) : null}
      </ViewerControls>
      {field.valueKind === 'displacement' && !field.times && !field.spectrum ? (
        <p className="my-2 text-xs text-slate-500">
          단일 상태의 변위입니다. 애니메이션에는 mesh와 전체 절점의 시간 이력이 필요합니다.
        </p>
      ) : null}
      {rendered.error || error ? (
        <p role="alert" className="rounded bg-rose-50 p-3 text-xs text-rose-700">
          {rendered.error ?? error}
        </p>
      ) : null}
      {rendered.data ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          {renderViewer ? (
            renderViewer(rendered.data, effectiveView)
          ) : (
            <JscadViewer
              layers={noLayers}
              lengthUnit={field.lengthUnit}
              meshRenderData={rendered.data}
              meshIdentity={field.identity}
              onRenderStart={onRender}
              onRenderEnd={onRendered ?? onRender}
              onRenderError={setError}
            />
          )}
        </div>
      ) : null}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-t p-2 text-xs text-slate-600">
        {view.component === 'material' ? (
          field.regionIds.map((name, index) => (
            <span className="flex items-center gap-1" key={name}>
              <span
                className="size-3 rounded-sm"
                style={{ background: meshMaterialColors[index % meshMaterialColors.length] }}
              />
              {name}
            </span>
          ))
        ) : (
          <>
            <span>
              {component} ({field.valueUnit})
            </span>
            <span>{rendered.data?.minimum.toPrecision(5)}</span>
            <span
              className="h-2 w-40 rounded"
              style={{ background: 'linear-gradient(to right, #0000ff, #00ffff, #ffff00, #ff0000)' }}
            />
            <span>{rendered.data?.maximum.toPrecision(5)}</span>
          </>
        )}
        {view.overlays ? <span>Green: fixed nodes · Red: load locations (arrows: force direction)</span> : null}
      </div>
    </article>
  )
}
