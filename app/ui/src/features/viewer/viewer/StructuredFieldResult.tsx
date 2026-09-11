import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { RecordedResultContract } from '@/contracts/results'
import type { RecordedData, RecordedDataRule, UcumUnit } from '@/lib/cad/model'
import { isDataTensor } from '@/lib/cad/model/dataTensor'
import {
  fieldRange,
  fieldSlice,
  oscillationSlice,
  oscillateSlice,
  structuredField,
  type HeatmapRenderData,
} from './structuredField'
import { ResultTensorView } from './ResultTensorView'
import { SpectralPlayback } from './SpectralPlayback'

export function StructuredFieldResult(props: {
  name: string
  contract: RecordedResultContract
  rules: readonly RecordedDataRule[]
  data?: RecordedData
  displayUnit: UcumUnit
  renderViewer: (data: HeatmapRenderData) => ReactNode
}) {
  const parsed = useMemo(() => {
    try {
      const rule = props.rules.find((rule) => rule.label === props.name)
      const value = props.data?.[props.name]
      if (!rule || !isDataTensor(value)) throw new Error('기록된 장 데이터가 없습니다.')
      return { field: structuredField(rule.result, value, props.contract.visualization, props.displayUnit), rule }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }, [props.name, props.rules, props.data, props.contract, props.displayUnit])
  return parsed.field && parsed.rule ? (
    <FieldControls key={props.name} {...props} field={parsed.field} rule={parsed.rule} />
  ) : (
    <p role="alert" className="p-3">
      {parsed.error}
    </p>
  )
}

function FieldControls({
  field,
  rule,
  ...props
}: Parameters<typeof StructuredFieldResult>[0] & {
  field: ReturnType<typeof structuredField>
  rule: RecordedDataRule
}) {
  const singleton = field.spatial.findIndex((axis) => axis.ticks.length === 1)
  const [normal, setNormal] = useState(singleton < 0 ? 2 : singleton)
  const [sliceIndex, setIndex] = useState(Math.floor(field.spatial[singleton < 0 ? 2 : singleton].ticks.length / 2))
  const [sampleIndex, setSample] = useState(0)
  const [componentIndex, setComponent] = useState(-1)
  const [representation, setRepresentation] = useState('abs')
  const [opacity, setOpacity] = useState(0.8)
  const [staticFixed, setStaticFixed] = useState<readonly [number, number] | null>(null)
  const [details, setDetails] = useState(false)
  const [oscillating, setOscillating] = useState(false)
  const [phase, setPhase] = useState(0)
  const [oscillationFixed, setOscillationFixed] = useState<readonly [number, number] | null>(null)
  const index = Math.min(sliceIndex, field.spatial[normal].ticks.length - 1)
  const sample = Math.min(sampleIndex, field.sampleTicks.length - 1)
  const component = componentIndex >= field.components.length ? -1 : componentIndex
  useEffect(() => {
    setIndex(index)
    setSample(sample)
    setComponent(component)
    if (field.grid.sampleKind !== 'frequency' || rule.result.dtype !== 'complex64') setOscillating(false)
  }, [field, rule, index, sample, component])
  const [magnitudeFixed, setMagnitudeFixed] = useState<readonly [number, number] | null>(null)
  const fixed = oscillating ? component < 0 ? magnitudeFixed : oscillationFixed : staticFixed
  const setFixed = oscillating ? component < 0 ? setMagnitudeFixed : setOscillationFixed : setStaticFixed
  const spectral = field.grid.sampleKind === 'frequency'
  const complex = rule.result.dtype === 'complex64'
  const projection = oscillating ? 're' : component < 0 ? 'abs' : complex ? representation : 're'
  const rendered = useMemo(() => {
    try {
      const limits = fieldRange(field, sample, component, oscillating ? 'peak' : projection)
      if (!oscillating) return { range: limits, zero: false }
      const amplitude = limits[1]
      return { range: [component < 0 ? 0 : -(amplitude || 1), amplitude || 1] as const, zero: amplitude === 0 }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }, [field, sample, component, projection, oscillating])
  const range = fixed ?? rendered.range ?? [0, 0]
  const cached = useMemo(() => {
    try {
      return oscillating ? { data: oscillationSlice(field, props.name, normal, index, sample, component) } : {}
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }, [field, props.name, normal, index, sample, component, oscillating])
  const slice = useMemo(() => {
    try {
      if (rendered.error || cached.error) return { error: rendered.error ?? cached.error }
      if (cached.data)
        return { data: oscillateSlice(cached.data, field.sampleTicks[sample] === 0 ? 0 : phase, range, opacity) }
      return { data: fieldSlice(field, props.name, normal, index, sample, component, projection, range, opacity) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }, [field, props.name, normal, index, sample, component, projection, range, opacity, rendered.error, cached, phase])
  const label =
    component < 0
      ? oscillating ? '전체 크기 · 순간값' : '전체 크기'
      : `${field.components[component]} · ${oscillating ? '진동값' : projection === 'abs' ? '진폭' : projection === 're' ? '실수부' : projection === 'im' ? '허수부' : '위상'}`
  const unit = projection === 'arg' ? 'rad' : rule.result.unit
  const current = field.sampleTicks[sample]
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b p-2 text-xs">
        {spectral && complex ? (
          <label>
            표시 모드{' '}
            <select
              aria-label="장 표시 모드"
              value={oscillating ? 'oscillating' : 'static'}
              onChange={(event) => {
                const next = event.target.value === 'oscillating'
                setOscillating(next)
              }}
            >
              <option value="static">정적</option>
              <option value="oscillating">진동</option>
            </select>
          </label>
        ) : null}
        <label>
          단면{' '}
          <select
            value={normal}
            onChange={(event) => {
              const n = Number(event.target.value)
              setNormal(n)
              setIndex(Math.floor(field.spatial[n].ticks.length / 2))
            }}
          >
            <option value={2}>XY</option>
            <option value={0}>YZ</option>
            <option value={1}>XZ</option>
          </select>
        </label>
        <label>
          위치{' '}
          <input
            aria-label="단면 위치"
            type="range"
            min={0}
            max={field.spatial[normal].ticks.length - 1}
            value={index}
            onChange={(event) => setIndex(Number(event.target.value))}
          />{' '}
          {field.spatial[normal].ticks[index].toPrecision(5)} {props.displayUnit}
        </label>
        <label>
          {spectral ? '주파수 / 진공 파장' : '시간'}{' '}
          <select
            value={sample}
            onChange={(event) => {
              setSample(Number(event.target.value))
              setPhase(0)
            }}
          >
            {field.sampleTicks.map((tick, i) => (
              <option key={i} value={i}>
                {tick.toPrecision(6)} {spectral ? 'Hz' : 's'}
                {spectral && tick > 0 ? ` · ${(299792458e9 / tick).toPrecision(6)} nm` : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          성분{' '}
          <select value={component} onChange={(event) => setComponent(Number(event.target.value))}>
            <option value={-1}>{oscillating ? '전체 크기 · 순간값' : '전체 크기'}</option>
            {field.components.map((name, i) => (
              <option key={name} value={i}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {spectral && complex ? <FieldFormulaTooltip label="성분 수식 도움말" unit={rule.result.unit} /> : null}
        {complex && component >= 0 && !oscillating ? (
          <label>
            표현{' '}
            <select value={representation} onChange={(event) => setRepresentation(event.target.value)}>
              <option value="abs">진폭</option>
              <option value="re">실수부</option>
              <option value="im">허수부</option>
              <option value="arg">위상</option>
            </select>
          </label>
        ) : null}
        <label>
          투명도{' '}
          <input
            aria-label="단면 투명도"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(event) => setOpacity(Number(event.target.value))}
          />{' '}
          {opacity}
        </label>
        <label>
          <input
            type="checkbox"
            checked={fixed !== null}
            onChange={(event) => setFixed(event.target.checked ? (rendered.range ?? [0, 1]) : null)}
          />{' '}
          색상 범위 고정
        </label>
        {fixed ? (
          <>
            {[0, 1].map((end) => (
              <input
                key={end}
                aria-label={end ? '색상 최댓값' : '색상 최솟값'}
                className="w-24 border"
                type="number"
                min={oscillating && component < 0 ? 0 : undefined}
                value={fixed[end]}
                onChange={(event) => {
                  const next: [number, number] = [...fixed]
                  next[end] = Number(event.target.value)
                  if (Number.isFinite(next[end]) && !(oscillating && component < 0 && next[end] < 0)) setFixed(next)
                }}
              />
            ))}
          </>
        ) : null}
        <label>
          <input type="checkbox" checked={details} onChange={(event) => setDetails(event.target.checked)} /> Table / 2D
          상세
        </label>
      </div>
      {oscillating && !details ? (
        <SpectralPlayback frequency={current} phase={phase} onPhase={setPhase} dataVersion={field} />
      ) : null}
      <div className="flex items-center gap-2 p-2 text-xs" role="status">
        {oscillating && rendered.zero ? <span>영장 · 모든 표본의 진폭 0</span> : null}
        <span>
          {label} [{unit}] · {current.toPrecision(6)} {spectral ? 'Hz' : 's'}
        </span>
        {spectral && complex ? <FieldFormulaTooltip label="범례 수식 도움말" unit={rule.result.unit} /> : null}
        <span>{range[0].toPrecision(4)}</span>
        <span className="h-3 w-32" style={{ background: 'linear-gradient(to right, blue, #80ff80, red)' }} />
        <span>{range[1].toPrecision(4)}</span>
        {projection === 'arg' ? <span>진폭 0의 위상은 미정의 (표시 제외)</span> : null}
      </div>
      {slice.error || range[0] > range[1] ? (
        <p role="alert" className="p-3">
          {slice.error ?? '색상 최솟값은 최댓값 이하여야 합니다.'}
        </p>
      ) : (
        <div className="min-h-0 flex-1">
          {details ? (
            <ResultTensorView name={props.name} contract={props.contract} rules={props.rules} data={props.data} />
          ) : slice.data ? (
            props.renderViewer(slice.data)
          ) : null}
        </div>
      )}
    </div>
  )
}


function FieldFormulaTooltip({ label, unit }: { label: string; unit?: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label={label} className="rounded border px-1 text-xs">수식 ⓘ</button>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm space-y-1">
          <p>F는 전기장 E 또는 자기장 H이며, i는 X·Y·Z 성분입니다. 단위: {unit}.</p>
          <p>정적 전체 크기: √Σᵢ|Fᵢ|²</p>
          <p>성분 순간값: Fᵢ(φ) = Re(Fᵢ) cosφ − Im(Fᵢ) sinφ</p>
          <p>순간 전체 크기: √(Fₓ(φ)² + Fᵧ(φ)² + Fz(φ)²)</p>
          <p>φ = 2πft (라디안). 화면 위상은 도(°)로 표시합니다.</p>
          <p>순간 전체 크기는 음수가 없고 반 주기마다 반복됩니다. 광강도나 원래 펄스의 시간 이력이 아닙니다.</p>
          <p>진동 전체 크기의 자동 범례는 공간 전체·한 주기의 최대 순간값으로 고정됩니다. 0 Hz는 실수부만 사용합니다.</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
