import { useQuery } from '@tanstack/react-query'
import { GitBranch, LoaderCircle } from 'lucide-react'
import { dbTables } from '@/api'

export function DefinitionLineageSummary({ id }: { id: number | null }) {
  const query = useQuery({
    queryKey: ['cae-workbench', 'experiment', 'save-lineage', id],
    queryFn: () => dbTables.Experiment.history(id!),
    enabled: id !== null,
  })
  const label = 'Experiment'

  if (id === null) {
    return (
      <div className="rounded-md border bg-muted/25 p-3 text-xs text-muted-foreground">
        저장하면 새 root {label} 계보가 시작됩니다.
      </div>
    )
  }
  if (query.isLoading) {
    return (
      <div className="rounded-md border bg-muted/25 p-3 text-xs text-muted-foreground">
        <LoaderCircle className="mr-2 inline size-3.5 animate-spin" /> 계보 확인 중…
      </div>
    )
  }
  if (!query.data) return null

  const current = query.data.items.find((item) => item.id === id)
  return (
    <div className="rounded-md border bg-muted/25 p-3 text-xs">
      <p className="flex items-center gap-2 font-medium">
        <GitBranch className="size-3.5 text-primary" /> root #{query.data.root_id} → 현재 #{id}
      </p>
      <p className="mt-1 text-muted-foreground">
        {current?.name ?? `${label} #${id}`} · source의 의미가 바뀌면 현재 항목을 parent로 하는 child가 생성됩니다.
      </p>
      <p className="mt-1 text-muted-foreground">보이는 계보 {query.data.items.length}개</p>
    </div>
  )
}
