import { ViewerLayout, ViewerToolHosts } from './ViewerTools'
import { ViewerResultSettings } from './ViewerDisplayControls'
import { ViewerSceneOnly } from './ViewerSceneLayers'
import { useCallback, useContext, useMemo, type ReactNode } from 'react'
import type { UcumUnit } from '@/lib/cad/model'
import { MeshPlayback } from './MeshPlayback'
import { meshFrameAtTime } from './meshDeformation'
import { useViewerSetting } from './comparisonSettings'
import { createParticleRenderData, particleFrameValues, type RecordedParticleSet } from './particleSets'
import type { MeshRenderData } from './meshFields'

export function ParticleSetResult({
  particles,
  displayUnit = particles.lengthUnit,
  renderViewer,
  canOverlayGeometry = false,
}: {
  particles: RecordedParticleSet
  displayUnit?: UcumUnit
  renderViewer: (data: MeshRenderData, showGeometry: boolean) => ReactNode
  canOverlayGeometry?: boolean
}) {
  const parentLayout = useContext(ViewerToolHosts)
  const sceneOnly = useContext(ViewerSceneOnly)
  const [time, setTime] = useViewerSetting(
    'particles.time',
    particles.times[0],
    'item',
    (value) => value >= particles.times[0] && value <= particles.times[particles.times.length - 1],
  )
  const [attribute, setAttribute] = useViewerSetting(
    'particles.attribute',
    'material',
    'item',
    (value) => value === 'material' || Boolean(particles.attributes[value]),
  )
  const [component, setComponent] = useViewerSetting<number | 'magnitude'>(
    'particles.component',
    0,
    'item',
    (value) => value === 'magnitude' || value < (particles.attributes[attribute]?.components.length || 1),
  )
  const [particleId, setParticleId] = useViewerSetting('particles.id', particles.particleIds[0], 'item', (value) =>
    particles.particleIds.includes(value),
  )
  const [pointSize, setPointSize] = useViewerSetting('particles.pointSize', 5)
  const [showGeometry] = useViewerSetting('particles.geometry', false)
  const frame = meshFrameAtTime(particles.times, time)
  const quantity = particles.attributes[attribute]
  const selectedParticle = particles.particleIds.indexOf(particleId)
  const available =
    Number.isFinite(time) && time >= particles.times[0] && time <= particles.times[particles.times.length - 1]
  const selectedComponent = component === 'magnitude' || component < (quantity?.components.length || 1) ? component : 0
  const values = useMemo(
    () => (quantity ? particleFrameValues(particles, attribute, selectedComponent, frame) : undefined),
    [particles, attribute, quantity, selectedComponent, frame],
  )
  const rendered = useMemo(
    () => (available ? createParticleRenderData(particles, frame, displayUnit, values, pointSize) : null),
    [particles, frame, displayUnit, values, pointSize, available],
  )
  const selectFrame = useCallback((next: number) => setTime(particles.times[next]), [particles.times, setTime])
  return (
    <ViewerLayout>
      <ViewerResultSettings name={particles.label} standalone={!parentLayout}>
        <div
          className="grid w-64 max-w-full gap-3 text-xs [&_select]:rounded [&_select]:border [&_select]:p-1"
          aria-label="Particle 설정"
        >
          <label className="grid gap-1">
            물리량
            <select
              aria-label="Particle 물리량"
              value={attribute}
              onChange={(event) => {
                setAttribute(event.target.value)
                setComponent(0)
              }}
            >
              <option value="material">Material</option>
              {Object.keys(particles.attributes).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
              {attribute !== 'material' && !quantity ? <option value={attribute}>{attribute} · 없음</option> : null}
            </select>
          </label>
          {quantity?.components.length ? (
            <label className="grid gap-1">
              성분
              <select
                aria-label="Particle 성분"
                value={selectedComponent}
                onChange={(event) =>
                  setComponent(event.target.value === 'magnitude' ? 'magnitude' : Number(event.target.value))
                }
              >
                {quantity.components.map((name, index) => (
                  <option key={name} value={index}>
                    {name}
                  </option>
                ))}
                <option value="magnitude">Norm</option>
              </select>
            </label>
          ) : null}
          {!particles.radius ? (
            <label className="grid gap-1">
              점 크기 · {pointSize}
              <input
                aria-label="Particle 점 크기"
                type="range"
                min={2}
                max={20}
                value={pointSize}
                onChange={(event) => setPointSize(Number(event.target.value))}
              />
            </label>
          ) : null}
          <label className="grid gap-1">
            Particle ID
            <select
              aria-label="Particle ID"
              value={particleId}
              onChange={(event) => setParticleId(Number(event.target.value))}
            >
              {particles.particleIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
              {selectedParticle < 0 ? <option value={particleId}>{particleId} · 없음</option> : null}
            </select>
          </label>
        </div>
      </ViewerResultSettings>
      <MeshPlayback
        name={particles.label}
        times={particles.times}
        unit="s"
        frame={frame}
        onFrame={selectFrame}
        time={time}
        onTime={setTime}
      />
      <article
        className={sceneOnly ? 'contents' : 'flex h-full min-h-0 flex-col bg-white'}
        data-result-visualization="particle-set"
        aria-label={`${particles.label} particles`}
      >
        {!sceneOnly ? (
          <h3 className="px-2 pt-2 text-sm font-semibold">{particles.label.replace(/^@visualizations\./u, '')}</h3>
        ) : null}
        {!sceneOnly ? (
          <p className="px-2 text-xs text-slate-500">
            {particles.particleIds.length} particles ·{' '}
            {particles.radius ? `실제 반경 · ${displayUnit}` : `위치 ${displayUnit} · 화면 점 크기`}
          </p>
        ) : null}
        {!sceneOnly ? (
          <div className="px-2 text-xs">
            {' '}
            {quantity ? (
              <span>
                {quantity.quantityKind} · {quantity.unit}
                {quantity.rowConfiguration && quantity.columnConfiguration
                  ? ' · 행: 현재 Cartesian · 열: 기준 Cartesian'
                  : ''}
              </span>
            ) : null}
          </div>
        ) : null}
        {!available ? (
          <p role="status" className="p-2 text-xs">
            선택한 시각이 현재 결과에 없습니다. 재생 시각을 조정하세요.
          </p>
        ) : null}
        {attribute !== 'material' && !quantity ? (
          <p role="status" className="p-2 text-xs">
            선택한 물리량이 현재 결과에 없습니다.
          </p>
        ) : null}
        {rendered ? (
          <div className={sceneOnly ? 'contents' : 'min-h-0 flex-1 overflow-hidden'}>
            {renderViewer(rendered, showGeometry && canOverlayGeometry)}
          </div>
        ) : null}
        {!sceneOnly && available && selectedParticle >= 0 ? (
          <div className="max-h-32 overflow-auto border-t p-2 text-xs">
            <p>
              ID {particleId} · Material {particles.materialNames[particles.materialIndices[selectedParticle]]} · t ={' '}
              {particles.times[frame]} s
            </p>
            <p>
              Position [
              {Array.from(
                particles.positions.subarray(
                  (frame * particles.particleIds.length + selectedParticle) * 3,
                  (frame * particles.particleIds.length + selectedParticle + 1) * 3,
                ),
              )
                .map((value) => value.toPrecision(5))
                .join(', ')}
              ] {particles.lengthUnit}
            </p>
            {Object.entries(particles.attributes).map(([name, entry]) => {
              const width = entry.components.length || 1
              const offset = (frame * particles.particleIds.length + selectedParticle) * width
              return (
                <p key={name}>
                  {name}:{' '}
                  {Array.from(entry.values.subarray(offset, offset + width))
                    .map((value) => value.toPrecision(5))
                    .join(', ')}{' '}
                  {entry.unit}
                </p>
              )
            })}
          </div>
        ) : null}
        {!sceneOnly && rendered?.minimum !== undefined ? (
          <p className="border-t px-2 text-xs">
            색상 범위 {rendered.minimum.toPrecision(4)} … {rendered.maximum?.toPrecision(4)} {quantity?.unit}
          </p>
        ) : null}
      </article>
    </ViewerLayout>
  )
}
