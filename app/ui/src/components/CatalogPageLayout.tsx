import type { ReactNode } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export function CatalogPageLayout({
  count,
  description,
  detail,
  filters,
  list,
  title,
  embedded = false,
}: {
  count: number
  description: string
  detail: ReactNode
  embedded?: boolean
  filters: ReactNode
  list: ReactNode
  title: string
}) {
  return (
    <div className={cn('space-y-6 px-4 py-7 sm:px-6', !embedded && 'mx-auto max-w-[1500px]')}>
      <PageHeader description={description} eyebrow={`${count.toLocaleString()} entries`} title={title} />
      <div className="grid min-h-[560px] gap-4 xl:grid-cols-[minmax(240px,0.65fr)_minmax(0,1.35fr)]">
        <Card className="min-w-0 overflow-hidden">
          <div className="border-b bg-muted/20 p-4">{filters}</div>
          <div className="max-h-[calc(100dvh-260px)] overflow-auto">{list}</div>
        </Card>
        <Card className="h-fit min-w-0 overflow-hidden xl:sticky xl:top-4">{detail}</Card>
      </div>
    </div>
  )
}
