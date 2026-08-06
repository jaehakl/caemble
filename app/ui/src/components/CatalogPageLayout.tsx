import type { ReactNode } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { Card } from '@/components/ui/card'

export function CatalogPageLayout({
  count,
  description,
  detail,
  filters,
  list,
  title,
}: {
  count: number
  description: string
  detail: ReactNode
  filters: ReactNode
  list: ReactNode
  title: string
}) {
  return (
    <div className="mx-auto max-w-[1500px] space-y-6 px-4 py-7 sm:px-6">
      <PageHeader description={description} eyebrow={`${count.toLocaleString()} entries`} title={title} />
      <div className="grid min-h-[560px] gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card className="min-w-0 overflow-hidden">
          <div className="border-b bg-muted/20 p-4">{filters}</div>
          <div className="max-h-[calc(100dvh-260px)] overflow-auto">{list}</div>
        </Card>
        <Card className="h-fit overflow-hidden xl:sticky xl:top-4">{detail}</Card>
      </div>
    </div>
  )
}
