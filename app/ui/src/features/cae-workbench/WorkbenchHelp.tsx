import { useQuery } from '@tanstack/react-query'
import { BookOpenText, Boxes, Cpu, Gauge, Layers3, LoaderCircle, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  catalogMaterialModelQueryOptions,
  catalogMaterialModelsQueryOptions,
  catalogMaterialParameterQueryOptions,
  catalogMaterialParametersQueryOptions,
  catalogQuantityKindQueryOptions,
  catalogQuantityKindsQueryOptions,
  catalogSolverQueryOptions,
  catalogSolversQueryOptions,
} from '@/features/catalog/queryOptions'
import { cadElementCatalog } from '@/lib/cad/catalog'
import { cn } from '@/lib/utils'
import type { HelpKindId } from '@/features/cae-workbench/types'
import { catalogDocsKnowledge, manualDocsKnowledge } from '@/features/docs/docsKnowledge'

export function WorkbenchHelpExplorer({
  kind,
  selectedItem,
  onSelectedItemChange,
}: {
  kind: HelpKindId
  selectedItem: string | null
  onSelectedItemChange: (item: string) => void
}) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLocaleLowerCase()
  const quantityKinds = useQuery(
    catalogQuantityKindsQueryOptions({ q: query.trim(), limit: 100 }, kind === 'quantity-kinds'),
  )
  const materialParameters = useQuery(
    catalogMaterialParametersQueryOptions({ q: query.trim(), limit: 100 }, kind === 'materials'),
  )
  const materialModels = useQuery(
    catalogMaterialModelsQueryOptions({ q: query.trim(), limit: 100 }, kind === 'materials'),
  )
  const solvers = useQuery(catalogSolversQueryOptions({ q: query.trim(), limit: 100 }, kind === 'solvers'))

  const items = useMemo(() => {
    if (kind === 'manual') {
      return manualDocsKnowledge
        .filter(
          (item) =>
            !needle || `${item.title} ${item.summary} ${item.keywords.join(' ')}`.toLocaleLowerCase().includes(needle),
        )
        .map((item) => ({ id: item.id, title: item.title, summary: item.summary, group: item.section }))
    }
    if (kind === 'geometry') {
      return cadElementCatalog
        .filter(
          (item) => !needle || `${item.authoringName} ${item.tag} ${item.summary}`.toLocaleLowerCase().includes(needle),
        )
        .map((item) => ({ id: item.tag, title: item.authoringName, summary: item.summary, group: item.category }))
    }
    if (kind === 'materials') {
      return [
        ...(materialParameters.data?.items ?? []).map((item) => ({
          id: item.key,
          title: item.labelKo || item.key,
          summary: item.quantityKind,
          group: 'parameter',
        })),
        ...(materialModels.data?.items ?? []).map((item) => ({
          id: item.key,
          title: item.labelKo || item.key,
          summary: `${item.input.quantityKind} → ${item.output.quantityKind}`,
          group: 'model',
        })),
      ]
    }
    if (kind === 'quantity-kinds') {
      return (quantityKinds.data?.items ?? []).map((item) => ({
        id: item.name,
        title: item.name,
        summary: item.description || item.applicableUnits.join(', '),
        group: item.domain,
      }))
    }
    return (solvers.data?.items ?? []).map((item) => ({
      id: `${item.name}@${item.version}`,
      title: item.name,
      summary: item.description,
      group: `v${item.version}`,
    }))
  }, [
    kind,
    materialModels.data?.items,
    materialParameters.data?.items,
    needle,
    quantityKinds.data?.items,
    solvers.data?.items,
  ])

  const loading =
    (quantityKinds.isPending && kind === 'quantity-kinds') ||
    (materialParameters.isPending && kind === 'materials') ||
    (materialModels.isPending && kind === 'materials') ||
    (solvers.isPending && kind === 'solvers')
  const error =
    kind === 'quantity-kinds'
      ? quantityKinds.error
      : kind === 'materials'
        ? (materialParameters.error ?? materialModels.error)
        : kind === 'solvers'
          ? solvers.error
          : null

  return (
    <section aria-label="Help 목록" className="flex h-full min-h-0 flex-col bg-background">
      <header className="space-y-3 border-b p-3">
        <div className="flex items-center gap-2">
          {kind === 'manual' ? <BookOpenText className="size-4" /> : null}
          {kind === 'geometry' ? <Boxes className="size-4" /> : null}
          {kind === 'materials' ? <Layers3 className="size-4" /> : null}
          {kind === 'quantity-kinds' ? <Gauge className="size-4" /> : null}
          {kind === 'solvers' ? <Cpu className="size-4" /> : null}
          <h2 className="font-semibold">{helpKindTitle(kind)}</h2>
        </div>
        <label className="relative block">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
          <Input
            aria-label="Help 검색"
            className="pl-9"
            placeholder="목록 검색"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <p className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" /> 목록을 불러오는 중…
          </p>
        ) : error ? (
          <p className="p-4 text-sm text-destructive">목록을 불러오지 못했습니다.</p>
        ) : items.length ? (
          <ul className="divide-y">
            {items.map((item) => (
              <li key={`${kind}:${item.id}`}>
                <button
                  aria-pressed={selectedItem === item.id}
                  className={cn(
                    'w-full px-3 py-3 text-left hover:bg-muted/60 focus-visible:bg-muted focus-visible:outline-none',
                    selectedItem === item.id && 'bg-primary/8',
                  )}
                  type="button"
                  onClick={() => onSelectedItemChange(item.id)}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{item.title}</span>
                    <Badge className="shrink-0 text-[10px]">{item.group}</Badge>
                  </span>
                  <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">
                    {item.summary}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">검색 결과가 없습니다.</p>
        )}
      </div>
    </section>
  )
}

export function WorkbenchHelpDetail({ kind, selectedItem }: { kind: HelpKindId; selectedItem: string | null }) {
  const materialParameter = useQuery(
    catalogMaterialParameterQueryOptions(
      selectedItem ?? '',
      kind === 'materials' && Boolean(selectedItem && !selectedItem.startsWith('model.')),
    ),
  )
  const materialModel = useQuery(
    catalogMaterialModelQueryOptions(
      selectedItem ?? '',
      kind === 'materials' && Boolean(selectedItem?.startsWith('model.')),
    ),
  )
  const quantityKind = useQuery(
    catalogQuantityKindQueryOptions(selectedItem ?? '', kind === 'quantity-kinds' && Boolean(selectedItem)),
  )
  const solverSeparator = selectedItem?.lastIndexOf('@') ?? -1
  const solverName = solverSeparator > 0 ? selectedItem!.slice(0, solverSeparator) : ''
  const solverVersion = solverSeparator > 0 ? selectedItem!.slice(solverSeparator + 1) : ''
  const solver = useQuery(
    catalogSolverQueryOptions(
      solverName,
      solverVersion,
      kind === 'solvers' && Boolean(solverName && solverVersion),
    ),
  )

  if (!selectedItem) return <EmptyHelpDetail kind={kind} />
  if (kind === 'manual' || kind === 'geometry') {
    const chunk =
      kind === 'manual'
        ? manualDocsKnowledge.find((item) => item.id === selectedItem)
        : catalogDocsKnowledge.find((item) => item.section === 'geometry' && item.item === selectedItem)
    if (!chunk) return <EmptyHelpDetail kind={kind} />
    return (
      <article className="h-full overflow-auto p-5">
        <Badge>{kind === 'manual' ? chunk.section : 'Geometry'}</Badge>
        <h2 className="mt-3 text-xl font-semibold">{chunk.title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{chunk.summary}</p>
        <div className="mt-5 space-y-4 text-sm leading-7 [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-zinc-950 [&_pre]:p-4 [&_pre]:text-zinc-50 [&_table]:w-full [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2 [&_ul]:list-disc [&_ul]:pl-5">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{chunk.content}</ReactMarkdown>
        </div>
      </article>
    )
  }

  const pending =
    (materialParameter.isPending && materialParameter.fetchStatus !== 'idle') ||
    (materialModel.isPending && materialModel.fetchStatus !== 'idle') ||
    (quantityKind.isPending && quantityKind.fetchStatus !== 'idle') ||
    (solver.isPending && solver.fetchStatus !== 'idle')
  if (pending) {
    return (
      <p className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" /> Detail을 불러오는 중…
      </p>
    )
  }
  const error = materialParameter.error ?? materialModel.error ?? quantityKind.error ?? solver.error
  if (error) return <p className="p-5 text-sm text-destructive">Detail을 불러오지 못했습니다.</p>

  if (kind === 'materials') {
    const parameter = materialParameter.data
    const model = materialModel.data
    return (
      <article className="h-full space-y-5 overflow-auto p-5 text-sm">
        <Badge>{model ? 'Material model' : 'Material parameter'}</Badge>
        <h2 className="font-mono text-xl font-semibold break-all">{model?.key ?? parameter?.key}</h2>
        <p className="text-muted-foreground">{model?.labelKo ?? parameter?.labelKo}</p>
        {parameter ? (
          <>
            <DetailRow label="Domain" value={parameter.domain} />
            <DetailRow label="Quantity Kind" value={parameter.quantityKind} mono />
            <DetailRow label="Qualifiers" value={parameter.specialQualifiers.join(', ') || '없음'} />
            <DetailRow
              label="Required by solvers"
              value={`${parameter.solverRequirements.length.toLocaleString()} contracts`}
            />
          </>
        ) : null}
        {model ? (
          <>
            <DetailRow label="Input" value={`${model.input.name} · ${model.input.quantityKind}`} mono />
            <DetailRow label="Output" value={`${model.output.name} · ${model.output.quantityKind}`} mono />
            <DetailRow label="Minimum samples" value={String(model.minimumSamples)} />
            <DetailRow label="Shared basis" value={model.sharedBasis ? '예' : '아니오'} />
          </>
        ) : null}
      </article>
    )
  }
  if (kind === 'quantity-kinds' && quantityKind.data) {
    const detail = quantityKind.data
    return (
      <article className="h-full space-y-5 overflow-auto p-5 text-sm">
        <Badge>{detail.domain}</Badge>
        <h2 className="font-mono text-xl font-semibold break-all">{detail.name}</h2>
        <p className="text-muted-foreground">{detail.description || '등록된 설명이 없습니다.'}</p>
        <DetailRow label="Tensor order" value={String(detail.tensorOrder)} />
        <DetailRow label="Applicable units" value={detail.applicableUnits.join(', ') || '없음'} mono />
        <DetailRow
          label="Material parameters"
          value={detail.materialParameters.map((item) => item.key).join(', ') || '없음'}
          mono
        />
        <DetailRow label="Solver usages" value={`${detail.solverUsages.length.toLocaleString()} contracts`} />
      </article>
    )
  }
  if (kind === 'solvers' && solver.data) {
    const detail = solver.data
    return (
      <article className="h-full space-y-5 overflow-auto p-5 text-sm">
        <Badge>Solver v{detail.version}</Badge>
        <h2 className="font-mono text-xl font-semibold break-all">{detail.name}</h2>
        <p className="text-muted-foreground">{detail.description}</p>
        <DetailRow label="Reference length unit" value={detail.descriptor.referenceLengthUnit} mono />
        <DetailRow label="Materials" value={`${detail.materialRequirements.length.toLocaleString()} requirements`} />
        <DetailRow label="Quantity kinds" value={`${detail.quantityKindUsages.length.toLocaleString()} usages`} />
        <DetailRow
          label="Artifact ports"
          value={`${detail.producesArtifacts.length} outputs · ${detail.consumesArtifacts.length} inputs`}
        />
      </article>
    )
  }
  return <EmptyHelpDetail kind={kind} />
}

function helpKindTitle(kind: HelpKindId) {
  return kind === 'manual'
    ? 'Manual'
    : kind === 'geometry'
      ? 'Geometry Catalog'
      : kind === 'materials'
        ? 'Material Catalog'
        : kind === 'quantity-kinds'
          ? 'Quantity Catalog'
          : 'Physics / Solvers'
}

function EmptyHelpDetail({ kind }: { kind: HelpKindId }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div>
        <BookOpenText className="mx-auto size-8 text-muted-foreground" />
        <p className="mt-3 font-medium">{helpKindTitle(kind)} 항목을 선택하세요</p>
        <p className="mt-1 text-sm text-muted-foreground">왼쪽 목록에서 상세 정보를 열 수 있습니다.</p>
      </div>
    </div>
  )
}

function DetailRow({ label, mono = false, value }: { label: string; mono?: boolean; value: string }) {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn('mt-1 break-all', mono && 'font-mono text-xs')}>{value}</p>
    </div>
  )
}
