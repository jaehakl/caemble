import { ArrowUpRight, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { DocsKnowledgeChunk } from '@/documentation/knowledge'
import { documentationSectionLabels } from '@/documentation/navigation'

export function HelpSearch({
  query,
  results,
  pending,
  failed,
  onRetry,
  onQueryChange,
}: {
  query: string
  results: readonly DocsKnowledgeChunk[]
  pending: boolean
  failed: boolean
  onRetry: () => void
  onQueryChange: (query: string) => void
}) {
  return (
    <div className="mx-auto max-w-4xl space-y-7 px-5 py-8 sm:px-9 sm:py-10" aria-live="polite">
      <header>
        <p className="mb-2 text-sm font-medium text-primary">사용 가이드 전체 검색</p>
        <h1 className="text-2xl font-semibold tracking-tight">‘{query}’ 검색 결과</h1>
        <p className="mt-3 text-sm text-muted-foreground" role="status">
          {pending
            ? '관련 문서와 카탈로그를 찾고 있습니다…'
            : `${results.length}개의 결과를 찾았습니다.${failed ? ' 카탈로그 결과는 포함하지 못했습니다.' : ''}`}
        </p>
      </header>
      {failed ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/25 p-4 text-sm leading-6">
          <p>
            카탈로그 검색을 불러오지 못했습니다.
            <br />
            사용 가이드와 형상 문서는 계속 검색할 수 있습니다.
          </p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            다시 시도
          </Button>
        </div>
      ) : null}
      {!pending && !results.length ? (
        <div className="rounded-2xl border border-dashed px-5 py-10 text-center">
          <Search className="mx-auto mb-4 size-6 text-muted-foreground" aria-hidden="true" />
          <h2 className="font-semibold">일치하는 문서를 찾지 못했습니다</h2>
          <p className="mt-2 text-sm leading-7 text-muted-foreground">
            짧은 단어나 화면에 표시된 이름으로 검색해 보세요.
            <br />
            예를 들어 ‘실행’, ‘단위’, ‘Ready’로 찾아볼 수 있습니다.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {['실행', '단위', 'Ready'].map((word) => (
              <Button key={word} variant="outline" size="sm" onClick={() => onQueryChange(word)}>
                {word}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      {[...new Set(results.map((result) => result.section))].map((section) => {
        const matches = results.filter((result) => result.section === section)
        return (
          <section key={section}>
            <h2 className="mb-2 flex items-center gap-2 border-b pb-3 text-sm font-semibold">
              {documentationSectionLabels[section] ?? '사용 가이드'}
              <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                {matches.length}
              </span>
            </h2>
            <div className="divide-y">
              {matches.slice(0, 20).map((result) => (
                <a
                  href={result.href}
                  key={result.id}
                  className="group block rounded-lg px-3 py-4 transition-colors hover:bg-muted/50"
                >
                  <span className="flex items-start gap-3 leading-7 font-medium group-hover:text-primary">
                    {result.title}
                    <ArrowUpRight className="mt-1 ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </span>
                  <span className="mt-1 block text-sm leading-7 text-muted-foreground">{result.summary}</span>
                </a>
              ))}
            </div>
            {matches.length > 20 ? (
              <p className="mt-3 text-xs leading-6 text-muted-foreground">
                관련성이 높은 20개를 먼저 표시합니다. 검색어를 더 구체적으로 입력하면 범위를 좁힐 수 있습니다.
              </p>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}
