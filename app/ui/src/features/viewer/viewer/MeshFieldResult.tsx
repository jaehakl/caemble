import { useCallback, useMemo, useState, type ReactNode } from 'react'
import {
  automaticDeformationScale,
  matchMeshDisplacement,
  meshHistoryBounds,
  meshHistoryRange,
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
  const [view, setView] = useState<MeshFieldView>({
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
  const [selectedDisplacement, setSelectedDisplacement] = useState<string | null>(null)
  const displacement =
    field.valueKind === 'displacement'
      ? field
      : selectedDisplacement !== null
        ? candidates.find((candidate) => candidate.label === selectedDisplacement)
        : candidates.length === 1
          ? candidates[0]
          : undefined
  const [deformed, setDeformed] = useState(true)
  const [scaleMode, setScaleMode] = useState('auto')
  const [manualScale, setManualScale] = useState(1)
  const [frame, setFrame] = useState(0)
  const canDeform = Boolean(displacement?.location === 'node' && displacement.componentCount === 3)
  const autoScale = useMemo(() => (displacement ? automaticDeformationScale(displacement) : 1), [displacement])
  const deformationScale =
    canDeform && deformed ? (scaleMode === 'auto' ? autoScale : scaleMode === 'actual' ? 1 : manualScale) : 0
  const currentField = useMemo(
    () =>
      field.historyValues
        ? {
            ...field,
            values: field.historyValues.subarray(frame * field.points.length, (frame + 1) * field.points.length),
          }
        : field,
    [field, frame],
  )
  const frameDisplacement = displacement === field ? currentField : displacement
  const range = useMemo(
    () => (field.times ? meshHistoryRange(field, view.component) : undefined),
    [field, view.component],
  )
  const animationBounds = useMemo(
    () => (field.times ? meshHistoryBounds(field, deformationScale, displayUnit) : undefined),
    [field, deformationScale, displayUnit],
  )
  const animationTopology = useMemo(
    () =>
      field.times && view.clipAxis < 0
        ? createMeshFieldRenderData(field, { ...view, deformationScale }, displayUnit).geometries
        : undefined,
    [field, view, deformationScale, displayUnit],
  )
  const effectiveView = { ...view, deformationScale }
  const [error, setError] = useState<string | null>(null)
  const rendered = useMemo(() => {
    try {
      const data = createMeshFieldRenderData(
        currentField,
        { ...view, deformationScale },
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
  }, [currentField, view, deformationScale, displayUnit, frameDisplacement, range, animationBounds, animationTopology])
  const onRender = useCallback(() => {}, [])
  const component = typeof view.component === 'number' ? field.components[view.component] : view.component
  return (
    <article
      className="rounded-lg border border-slate-200 bg-white p-4"
      data-result-visualization="mesh field"
      aria-label={`${field.label} mesh field`}
    >
      <h3 className="text-sm font-semibold text-slate-900">{field.label}</h3>
      <p className="mt-1 text-xs text-slate-500">
        {(field.points.length / 3).toLocaleString()} nodes · {(field.cells.length / 4).toLocaleString()} tetrahedra ·{' '}
        {field.location} values · coordinates {field.lengthUnit}
      </p>
      <div className="my-3 flex flex-wrap items-center gap-3 text-xs text-slate-700">
        <label>
          Field{' '}
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
          Mesh edges
        </label>
        <label>
          <input
            type="checkbox"
            checked={view.overlays}
            onChange={(event) => setView({ ...view, overlays: event.target.checked })}
          />{' '}
          Supports / loads
        </label>
        <label>
          Section{' '}
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
              <option value="">{candidates.length ? '선택 안 함' : '호환되는 정적 변위 없음'}</option>
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
      {field.times ? (
        <MeshPlayback times={field.times} unit={field.timeUnit!} frame={frame} onFrame={setFrame} />
      ) : null}
      {field.valueKind === 'displacement' && !field.times ? (
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
        <div className="h-[480px] overflow-hidden rounded border border-slate-200">
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
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-600">
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
