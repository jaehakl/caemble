import { useCallback, useMemo, useState } from 'react'
import JscadViewer from './JscadViewer'
import { createMeshFieldRenderData, meshMaterialColors, type MeshFieldView, type RecordedMeshField } from './meshFields'
import type { JscadViewerLayer } from './model'

const noLayers: readonly JscadViewerLayer[] = Object.freeze([])

export function MeshFieldResult({ field, onRendered }: { field: RecordedMeshField; onRendered?: () => void }) {
  const [view, setView] = useState<MeshFieldView>({
    component: field.componentCount === 6 || field.componentCount === 9 ? 'vonMises' : 'magnitude',
    wireframe: true,
    overlays: true,
    clipAxis: -1,
    clipFraction: 0.5,
    deformationScale: 0,
  })
  const [error, setError] = useState<string | null>(null)
  const rendered = useMemo(() => {
    try {
      return { data: createMeshFieldRenderData(field, view), error: null }
    } catch (error) {
      return { data: null, error: error instanceof Error ? error.message : String(error) }
    }
  }, [field, view])
  const onRender = useCallback(() => {}, [])
  const canDeform = field.location === 'node' && field.componentCount === 3 && /displacement/i.test(field.quantity)
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
            {field.componentCount === 6 || field.componentCount === 9 ? (
              <option value="vonMises">von Mises</option>
            ) : null}
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
        {canDeform ? (
          <label>
            Displacement scale{' '}
            <input
              aria-label={`${field.label} displacement scale`}
              className="w-20 rounded border p-1"
              type="number"
              min={0}
              step={1}
              value={view.deformationScale}
              onChange={(event) => setView({ ...view, deformationScale: Math.max(0, Number(event.target.value)) })}
            />
            ×
          </label>
        ) : null}
      </div>
      {rendered.error || error ? (
        <p role="alert" className="rounded bg-rose-50 p-3 text-xs text-rose-700">
          {rendered.error ?? error}
        </p>
      ) : null}
      {rendered.data ? (
        <div className="h-[480px] overflow-hidden rounded border border-slate-200">
          <JscadViewer
            layers={noLayers}
            lengthUnit={field.lengthUnit}
            meshRenderData={rendered.data}
            meshIdentity={field.identity}
            onRenderStart={onRender}
            onRenderEnd={onRendered ?? onRender}
            onRenderError={setError}
          />
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
