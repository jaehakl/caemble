import { useState, type MouseEvent } from 'react'
import type { MeasurementProjection } from './measurementSpace'

export type MeasurementChartPoint = Readonly<{ id: string; label: string; state: string; xy: readonly number[] }>
export function MeasurementPcaChart({
  projection,
  points,
  current,
  selected,
  disabled,
  onSelect,
  onSpace,
}: {
  projection: MeasurementProjection | null
  points: readonly MeasurementChartPoint[]
  current?: readonly number[]
  selected: ReadonlySet<string>
  disabled: boolean
  onSelect: (id: string, additive: boolean) => void
  onSpace: (xy: readonly number[]) => void
}) {
  const [overlap, setOverlap] = useState<readonly MeasurementChartPoint[]>([])
  // Keep screen-to-PCA coordinates stable while a candidate is being edited.
  let xmin = 0,
    xmax = 0,
    ymin = 0,
    ymax = 0
  for (const point of projection?.points ?? []) {
    xmin = Math.min(xmin, point.xy[0])
    xmax = Math.max(xmax, point.xy[0])
    ymin = Math.min(ymin, point.xy[1])
    ymax = Math.max(ymax, point.xy[1])
  }
  const xpad = Math.max((xmax - xmin) * 0.1, 0.05),
    ypad = Math.max((ymax - ymin) * 0.1, 0.05)
  xmin -= xpad
  xmax += xpad
  ymin -= ypad
  ymax += ypad
  const x = (value: number) => 45 + ((value - xmin) / (xmax - xmin)) * 530
  const y = (value: number) => 235 - ((value - ymin) / (ymax - ymin)) * 210
  const color: Record<string, string> = {
    candidate: '#6366f1',
    prepared: '#94a3b8',
    running: '#f59e0b',
    recorded: '#10b981',
    failed: '#ef4444',
    cancelled: '#64748b',
  }
  const click = (event: MouseEvent<SVGSVGElement>) => {
    if (disabled) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const px = ((event.clientX - bounds.left) / bounds.width) * 600,
      py = ((event.clientY - bounds.top) / bounds.height) * 270
    const hits = points.filter(
      (point) =>
        Math.hypot(((x(point.xy[0]) - px) / 600) * bounds.width, ((y(point.xy[1]) - py) / 270) * bounds.height) <= 8,
    )
    if (hits.length > 1) {
      setOverlap(hits)
      return
    }
    setOverlap([])
    if (hits[0]) {
      onSelect(hits[0].id, event.ctrlKey || event.metaKey || event.shiftKey)
      return
    }
    if (!projection?.axes.length || px < 45 || px > 575 || py < 25 || py > 235) return
    onSpace([
      xmin + ((px - 45) / 530) * (xmax - xmin),
      projection.axes.length > 1 ? ymin + ((235 - py) / 210) * (ymax - ymin) : 0,
    ])
  }
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <svg
        aria-label="Vars PCA 차트"
        className="min-h-0 w-full flex-1"
        viewBox="0 0 600 270"
        preserveAspectRatio="none"
        onClick={click}
      >
        <rect x="45" y="25" width="530" height="210" fill="transparent" stroke="currentColor" className="text-border" />
        <line x1={x(0)} x2={x(0)} y1="25" y2="235" stroke="currentColor" className="text-border" />
        <line x1="45" x2="575" y1={y(0)} y2={y(0)} stroke="currentColor" className="text-border" />
        {points.map((point) => (
          <circle
            key={point.id}
            cx={x(point.xy[0])}
            cy={y(point.xy[1])}
            r={selected.has(point.id) ? 6 : 4}
            fill={color[point.state] ?? color.candidate}
            stroke={selected.has(point.id) ? 'currentColor' : 'none'}
            tabIndex={disabled ? -1 : 0}
            role="button"
            aria-label={`${point.label} · ${point.state}`}
            aria-pressed={selected.has(point.id)}
            onKeyDown={(event) => {
              if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault()
                onSelect(point.id, event.ctrlKey || event.metaKey || event.shiftKey)
              }
            }}
          >
            <title>
              {point.label} · {point.state}
            </title>
          </circle>
        ))}
        {current ? (
          <circle
            aria-label="현재 Vars"
            cx={x(current[0])}
            cy={y(current[1])}
            r="8"
            fill="none"
            stroke="#f97316"
            strokeWidth="2"
          />
        ) : null}
        <text x="310" y="262" textAnchor="middle" fontSize="11" fill="currentColor">
          PC1 · {((projection?.variance[0] ?? 0) * 100).toFixed(1)}%
        </text>
        <text x="8" y="14" fontSize="11" fill="currentColor">
          PC2 · {((projection?.variance[1] ?? 0) * 100).toFixed(1)}%
        </text>
      </svg>
      {!projection?.axes.length ? (
        <p className="px-3 text-xs text-muted-foreground">
          PCA 방향을 계산할 분산이 없습니다. 구성 탭의 일괄생성으로 Measurement를 추가하세요.
        </p>
      ) : null}
      {overlap.length ? (
        <div
          className="absolute top-2 right-2 max-h-44 overflow-auto rounded border bg-background p-2 shadow-md"
          role="group"
          aria-label="겹친 점 선택"
        >
          {overlap.map((point) => (
            <button
              key={point.id}
              type="button"
              className="block w-full px-2 py-1 text-left text-xs hover:bg-accent"
              onClick={(event) => {
                onSelect(point.id, event.ctrlKey || event.metaKey)
                setOverlap([])
              }}
            >
              {point.label}
            </button>
          ))}
          <button className="text-xs" onClick={() => setOverlap([])}>
            닫기
          </button>
        </div>
      ) : null}
      <div className="flex shrink-0 flex-wrap gap-2 px-3 py-1 text-[10px] text-muted-foreground">
        {Object.entries({
          candidate: '현재 Vars',
          prepared: 'Prepared',
          running: '실행 중',
          recorded: 'Recorded',
          failed: '실패',
          cancelled: '취소',
        }).map(([state, label]) => (
          <span key={state} className="flex items-center gap-1">
            <span className="size-2 rounded-full" style={{ background: color[state] }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}
