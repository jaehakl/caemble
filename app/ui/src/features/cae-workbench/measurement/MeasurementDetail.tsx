import { Database, FlaskConical } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { isRayPathRecordedDataName, type RayPathBundle } from '@/lib/cad'
import type { SavedMeasurement, SavedRecordedData } from '../types'
import { RayPathSystemCard } from './RayPathSystemCard'

function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString('ko-KR') : '—'
}

function DetailField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm break-all">{value}</dd>
    </div>
  )
}

function MaterialSnapshot({
  label,
  snapshot,
}: {
  label: string
  snapshot: SavedMeasurement['material_parameters']['experiment']
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="truncate text-xs font-semibold">{label}</p>
        <Badge className="border bg-transparent">{Object.keys(snapshot.materials).length} materials</Badge>
      </div>
      <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-[11px] break-all whitespace-pre-wrap">
        {JSON.stringify(
          {
            materials: snapshot.materials,
            ...(snapshot.materialColors ? { materialColors: snapshot.materialColors } : {}),
          },
          null,
          2,
        )}
      </pre>
    </div>
  )
}

function RecordedLeaf({ row }: { row: SavedRecordedData }) {
  return (
    <div className="rounded-md border p-3">
      <p className="truncate text-sm font-medium">{row.name.slice(row.name.lastIndexOf('.') + 1)}</p>
      <dl className="mt-2 grid grid-cols-2 gap-2">
        <DetailField label="Quantity Kind" value={row.quantity_kind ?? '—'} />
        <DetailField label="Dtype" value={row.dtype} />
        <DetailField label="Tensor order" value={row.tensor_order} />
        <DetailField
          label="File size"
          value={row.file_size === null || row.file_size === undefined ? '—' : `${row.file_size.toLocaleString()} B`}
        />
      </dl>
      {row.data_schema ? (
        <pre className="mt-2 max-h-24 overflow-auto rounded bg-muted p-2 text-[10px] break-all whitespace-pre-wrap">
          {JSON.stringify(row.data_schema, null, 2)}
        </pre>
      ) : null}
    </div>
  )
}

function RecordedRows({ rows, depth = 0 }: { rows: readonly SavedRecordedData[]; depth?: number }) {
  const grouped = new Map<string, SavedRecordedData[]>()
  rows.forEach((row) => {
    const name = row.name.split('.')[depth]
    if (name) grouped.set(name, [...(grouped.get(name) ?? []), row])
  })
  return (
    <ul className="space-y-2">
      {[...grouped].map(([name, members]) => {
        const leaf = members.length === 1 && members[0].name.split('.').length === depth + 1
        return (
          <li key={`${depth}-${name}`}>
            {leaf ? (
              <RecordedLeaf row={members[0]} />
            ) : (
              <section className="rounded-md border p-3" aria-label={`RecordedData group ${name}`}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-semibold">{name}</p>
                  <Badge className="border bg-transparent">group</Badge>
                </div>
                <RecordedRows rows={members} depth={depth + 1} />
              </section>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function MeasurementDetail({
  className,
  measurement,
  pendingSave = false,
  rayPathBundles = [],
  rayPathsDeclared: rayPathsDeclaredProp = false,
  rayPathError = null,
  recordedRows = [],
}: {
  className?: string
  measurement: SavedMeasurement | null
  pendingSave?: boolean
  rayPathBundles?: readonly RayPathBundle[]
  rayPathsDeclared?: boolean
  rayPathError?: string | null
  recordedRows?: readonly SavedRecordedData[]
}) {
  if (!measurement)
    return (
      <div
        className={cn(
          'grid h-full min-h-48 place-items-center p-5 text-center text-sm text-muted-foreground',
          className,
        )}
      >
        왼쪽 목록에서 Measurement를 선택하세요.
      </div>
    )

  const regularRows = recordedRows.filter((row) => !isRayPathRecordedDataName(row.name))
  const rayPathsDeclared =
    rayPathsDeclaredProp || recordedRows.some((row) => isRayPathRecordedDataName(row.name))
  const hasRayPathSystemResult = rayPathsDeclared || rayPathBundles.length > 0 || Boolean(rayPathError)
  const displayedResultCount =
    new Set(regularRows.map((row) => row.name.split('.')[0])).size + (hasRayPathSystemResult ? 1 : 0)

  return (
    <div className={cn('h-full space-y-4 overflow-y-auto p-3', className)}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Measurement</p>
          <h2 className="truncate text-lg font-semibold">#{measurement.id}</h2>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          {pendingSave ? <Badge className="bg-amber-100 text-amber-900">저장 대기</Badge> : null}
          <Badge className={measurement.recorded_at ? 'bg-emerald-100 text-emerald-800' : undefined}>
            {measurement.recorded_at ? 'Recorded' : 'Prepared'}
          </Badge>
        </div>
      </header>

      <Card>
        <CardHeader className="p-3 pb-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FlaskConical className="size-4 text-primary" />
            Detail
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3">
          <dl className="grid gap-3 sm:grid-cols-2">
            <DetailField label="Experiment" value={`#${measurement.experiment_id}`} />
            <DetailField label="Owner" value={measurement.user_id ?? '—'} />
            <DetailField label="Created" value={formatDate(measurement.created_at)} />
            <DetailField label="Updated" value={formatDate(measurement.updated_at)} />
            <DetailField label="Recorded" value={formatDate(measurement.recorded_at)} />
          </dl>
        </CardContent>
      </Card>

      <section className="space-y-2" aria-labelledby="measurement-vars-title">
        <h3 className="text-sm font-semibold" id="measurement-vars-title">
          Variables
        </h3>
        <pre className="max-h-48 overflow-auto rounded-md border bg-muted/50 p-3 text-xs break-all whitespace-pre-wrap">
          {JSON.stringify(measurement.vars, null, 2)}
        </pre>
      </section>

      <section className="space-y-2" aria-labelledby="measurement-materials-title">
        <h3 className="text-sm font-semibold" id="measurement-materials-title">
          Material snapshots
        </h3>
        <MaterialSnapshot label="Experiment" snapshot={measurement.material_parameters.experiment} />
        {Object.entries(measurement.material_parameters.tasks).map(([taskName, snapshot]) => (
          <MaterialSnapshot key={taskName} label={`Task · ${taskName}`} snapshot={snapshot} />
        ))}
      </section>

      <section className="space-y-2" aria-labelledby="measurement-recorded-title">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold" id="measurement-recorded-title">
            <Database className="size-4 text-primary" />
            Recorded Data
          </h3>
          <Badge className="border bg-transparent">{displayedResultCount}</Badge>
        </div>
        {displayedResultCount ? (
          <div className="space-y-2">
            <RayPathSystemCard bundles={rayPathBundles} declared={rayPathsDeclared} error={rayPathError} />
            <RecordedRows rows={regularRows} />
          </div>
        ) : (
          <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
            기록된 데이터가 없습니다.
          </div>
        )}
      </section>
    </div>
  )
}
