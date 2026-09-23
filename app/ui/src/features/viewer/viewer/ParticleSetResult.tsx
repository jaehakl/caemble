import { Component, Circle, Fingerprint, Shapes } from 'lucide-react'
import { ViewerLayout, ViewerToolPanel, ViewerSelectTool } from './ViewerTools'
import { useCallback, useMemo, type ReactNode } from 'react'
import type { UcumUnit } from '@/lib/cad/model'
import { MeshPlayback } from './MeshPlayback'
import { meshFrameAtTime } from './meshDeformation'
import { useViewerSetting, ViewerControls } from './comparisonSettings'
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
      <article
        className="flex h-full min-h-0 flex-col bg-white"
        data-result-visualization="particle-set"
        aria-label={`${particles.label} particles`}
      >
        <h3 className="px-2 pt-2 text-sm font-semibold">{particles.label.replace(/^@visualizations\./u, '')}</h3>
        <p className="px-2 text-xs text-slate-500">
          {particles.particleIds.length} particles ·{' '}
          {particles.radius ? `실제 반경 · ${displayUnit}` : `위치 ${displayUnit} · 화면 점 크기`}
        </p>
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
        <ViewerControls>
          <MeshPlayback
            times={particles.times}
            unit="s"
            frame={frame}
            onFrame={selectFrame}
            time={time}
            onTime={setTime}
          />
          <ViewerSelectTool
            label="물리량"
            icon={<Shapes />}
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
          </ViewerSelectTool>
          {quantity?.components.length ? (
            <ViewerSelectTool
              label="성분"
              icon={<Component />}
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
            </ViewerSelectTool>
          ) : null}
          {!particles.radius ? (
            <ViewerToolPanel label="점 크기" icon={<Circle />}>
              <input
                aria-label="Particle 점 크기"
                type="range"
                min={2}
                max={20}
                value={pointSize}
                onChange={(event) => setPointSize(Number(event.target.value))}
              />
            </ViewerToolPanel>
          ) : null}
          <ViewerSelectTool
            label="Particle ID"
            icon={<Fingerprint />}
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
          </ViewerSelectTool>
        </ViewerControls>
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
          <div className="min-h-0 flex-1 overflow-hidden">
            {renderViewer(rendered, showGeometry && canOverlayGeometry)}
          </div>
        ) : null}
        {available && selectedParticle >= 0 ? (
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
        {rendered?.minimum !== undefined ? (
          <p className="border-t px-2 text-xs">
            색상 범위 {rendered.minimum.toPrecision(4)} … {rendered.maximum?.toPrecision(4)} {quantity?.unit}
          </p>
        ) : null}
      </article>
    </ViewerLayout>
  )
}
