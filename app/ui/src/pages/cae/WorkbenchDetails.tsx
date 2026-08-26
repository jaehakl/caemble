import { AlertTriangle, CheckCircle2, FileCode2, FlaskConical, Link2, LockKeyhole } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { experimentTaskPaths } from '@/lib/cad'

export function ExperimentDetail({ workbench }: { workbench: CaeWorkbenchState }) {
  const record = workbench.experimentRecord
  const files = Object.keys(workbench.experiment?.sourceBundle.files ?? {}).sort()
  const tasks = workbench.experiment ? experimentTaskPaths(workbench.experiment.sourceBundle) : []
  const counts = record?.derivedCounts
  const diagnostics = workbench.experimentDocument.diagnostics

  return (
    <section aria-label="Experiment Detail" className="h-full overflow-auto bg-background p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-wide text-primary uppercase">Experiment Detail</p>
          <h2 className="mt-1 truncate text-lg font-semibold">{workbench.experimentName}</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {workbench.experimentDescription || '등록된 설명이 없습니다.'}
          </p>
        </div>
        <FlaskConical className="size-5 shrink-0 text-primary" />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Badge>{record ? 'Saved' : 'Local'}</Badge>
        <Badge className={workbench.experimentDirty ? 'bg-destructive text-white' : 'bg-emerald-600 text-white'}>
          {workbench.experimentDirty ? 'Dirty' : 'Clean'}
        </Badge>
        {workbench.sourceLocked ? (
          <Badge className="bg-amber-600 text-white">
            <LockKeyhole />
            Locked
          </Badge>
        ) : null}
        <Badge>{workbench.experimentDocument.status}</Badge>
      </div>

      <dl className="mt-5 grid gap-3 text-sm">
        <DetailItem label="ID" value={record?.id ? `#${record.id}` : '저장되지 않음'} />
        <DetailItem label="Coordinate" value={workbench.experimentCoordinate ?? 'local Experiment'} mono />
        <DetailItem label="Version" value={workbench.experimentVersion ? `v${workbench.experimentVersion}` : '없음'} />
        <DetailItem label="Owner" value={record?.user_id ?? 'local / public'} mono />
        <DetailItem
          label="Created"
          value={record?.created_at ? new Date(record.created_at).toLocaleString('ko-KR') : '—'}
        />
        <DetailItem
          label="Updated"
          value={record?.updated_at ? new Date(record.updated_at).toLocaleString('ko-KR') : '—'}
        />
        <DetailItem label="Source hash" value={record?.source_hash ?? '저장 후 생성됨'} mono />
        <DetailItem
          label="Bundle format"
          value={workbench.experiment ? `${Object.keys(workbench.experiment.sourceBundle.files).length} files` : '—'}
        />
      </dl>

      <div className="mt-5 grid grid-cols-2 gap-2">
        <SummaryCard icon={<FileCode2 />} label="Files" value={files.length} />
        <SummaryCard icon={<FlaskConical />} label="Tasks" value={tasks.length} />
        <SummaryCard icon={<Link2 />} label="Measurements" value={counts?.measurements ?? 0} />
        <SummaryCard icon={<Link2 />} label="RecordedData" value={counts?.recordedData ?? 0} />
        <SummaryCard icon={<Link2 />} label="Designer" value={counts?.designerModels ?? 0} />
        <SummaryCard icon={<Link2 />} label="Predictor" value={counts?.predictorModels ?? 0} />
      </div>

      <section className="mt-5 rounded-md border" aria-labelledby="experiment-diagnostics-title">
        <header className="flex items-center justify-between border-b bg-muted/30 px-3 py-2">
          <h3 className="text-xs font-semibold" id="experiment-diagnostics-title">
            Evaluation diagnostics
          </h3>
          <Badge>{diagnostics.length}</Badge>
        </header>
        {diagnostics.length ? (
          <ul className="divide-y">
            {diagnostics.slice(0, 20).map((diagnostic, index) => (
              <li className="flex gap-2 px-3 py-2 text-xs" key={`${diagnostic.code}:${index}`}>
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                <span className="min-w-0 break-words">{diagnostic.message}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
            <CheckCircle2 className="size-4 text-emerald-600" /> 현재 진단이 없습니다.
          </p>
        )}
      </section>
    </section>
  )
}

function DetailItem({ label, mono = false, value }: { label: string; mono?: boolean; value: string }) {
  return (
    <div className="rounded-md border bg-muted/15 p-3">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-all ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  )
}

function SummaryCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {label}
      </span>
      <strong className="mt-1 block text-lg tabular-nums">{value.toLocaleString()}</strong>
    </div>
  )
}
