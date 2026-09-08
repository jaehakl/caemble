import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, BookOpenText, Menu, Search, X } from 'lucide-react'
import { createElement, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CopyButton } from '@/components/CopyButton'
import { catalogSearchQueryOptions } from '@/features/catalog/queryOptions'
import { catalogSearchKnowledge, getDocsKnowledge, searchDocsKnowledge } from '@/documentation/knowledge'
import { publicDocuments } from '@/documentation/public'
import { helpHref, legacyDocsHref, type HelpKindId } from '@/documentation/helpNavigation'
import { useDebouncedValue } from '@/shared/useDebouncedValue'

const GeometryCatalog = lazy(() =>
  import('@/features/catalog/cad/CadCatalogPage').then((m) => ({ default: m.GeometryCatalog })),
)
const MaterialCatalog = lazy(() =>
  import('@/features/catalog/materials/MaterialCatalogPage').then((m) => ({ default: m.MaterialCatalog })),
)
const QuantityCatalog = lazy(() =>
  import('@/features/catalog/quantity-kinds/QuantityKindCatalogPage').then((m) => ({ default: m.QuantityCatalog })),
)
const PhysicsCatalog = lazy(() =>
  import('@/features/catalog/solvers/SolverCatalogPage').then((m) => ({ default: m.PhysicsCatalog })),
)
const ExampleCatalog = lazy(() =>
  import('@/features/catalog/solvers/SolverCatalogPage').then((m) => ({ default: m.ExampleExperimentCatalog })),
)

const journeys = [
  {
    title: '시작하기',
    summary: '첫 Experiment를 준비하고 실행 흐름을 익힙니다.',
    ids: ['workbench-quickstart', 'workbench-authoring-cycle', 'workbench-viewer-selection'],
  },
  {
    title: 'Experiment 작성',
    summary: '형상, 변수, 재료와 Solver 작업을 구성합니다.',
    ids: [
      'program-overview',
      'program-definition',
      'program-materials',
      'program-task',
      'program-ray-tracing',
      'program-runtime-rules',
    ],
  },
  {
    title: '실행·결과 확인',
    summary: 'Measurement를 실행하고 기록된 결과를 확인합니다.',
    ids: ['program-simulate', 'program-domain-recording', 'program-verified-examples', 'program-multiphysics-example'],
  },
  {
    title: 'Calculation·Prediction',
    summary: '결과를 계산하고 다음 변수 조건을 탐색합니다.',
    ids: ['workbench-calculation', 'workbench-prediction', 'workbench-analysis'],
  },
  {
    title: '문제 해결',
    summary: '증상에서 시작해 확인할 위치와 해결 방법을 찾습니다.',
    ids: publicDocuments.filter((p) => p.section === 'troubleshooting').map((p) => p.id),
  },
]
const catalogs: { kind: HelpKindId; label: string }[] = [
  { kind: 'geometry', label: 'Geometry' },
  { kind: 'materials', label: 'Material Model' },
  { kind: 'quantity-kinds', label: 'QuantityKind' },
  { kind: 'solvers', label: 'Solver' },
  { kind: 'examples', label: 'Examples' },
]
const localKnowledge = getDocsKnowledge()

export function HelpWorkspace({
  kind,
  item,
  anchor,
  onNavigate,
  onClose,
}: {
  kind: HelpKindId
  item: string | null
  anchor: string | null
  onNavigate: (href: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const settledQuery = useDebouncedValue(query.trim())
  const catalogSearch = useQuery(catalogSearchQueryOptions(settledQuery, 100, Boolean(settledQuery)))
  const results = useMemo(
    () => searchDocsKnowledge(settledQuery, [...localKnowledge, ...catalogSearchKnowledge(catalogSearch.data ?? [])]),
    [settledQuery, catalogSearch.data],
  )
  const document = kind === 'manual' ? publicDocuments.find((p) => p.id === item) : undefined
  const contentRef = useRef<HTMLDivElement>(null)
  const headings = useMemo(() => {
    let fenced = false
    const seen = new Map<string, number>()
    return (document?.content ?? '').split('\n').flatMap((line, index) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
      const match = !fenced && /^(#{2,4})\s+(.+)/.exec(line)
      if (!match) return []
      const title = match[2].replace(/[`*_]/g, '')
      const base = title
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-')
      const count = seen.get(base) ?? 0
      seen.set(base, count + 1)
      return [{ id: `${base}${count ? `-${count}` : ''}`, title, level: match[1].length, line: index + 1 }]
    })
  }, [document?.content])
  const journey = journeys.find((group) => group.ids.includes(item ?? ''))
  const related = document
    ? journey
      ? journey.ids
      : publicDocuments.filter((p) => p.section === document.section).map((p) => p.id)
    : []
  const next = related[related.indexOf(item ?? '') + 1]
  const navigate = (href: string) => {
    setQuery('')
    setMenuOpen(false)
    onNavigate(href)
  }

  useEffect(() => {
    contentRef.current?.scrollTo?.(0, 0)
    if (!anchor) return
    const target = [...(contentRef.current?.querySelectorAll<HTMLElement>('[id]') ?? [])].find(
      (node) => node.id === anchor,
    )
    target?.scrollIntoView?.({ block: 'start' })
  }, [kind, item, anchor])

  const title =
    kind === 'home'
      ? 'Help'
      : kind === 'manual'
        ? (document?.title ?? '매뉴얼')
        : catalogs.find((c) => c.kind === kind)?.label
  return (
    <section
      aria-label="Workbench Help"
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      onClickCapture={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return
        const link = (event.target as HTMLElement).closest('a[href]')
        const href = link?.getAttribute('href')
        if (!href || link?.getAttribute('target') === '_blank') return
        let target: string | undefined
        if (href.startsWith('/docs')) {
          const url = new URL(href, window.location.origin)
          target = legacyDocsHref(url.search, url.hash)
        } else if (href.startsWith('/?help=')) target = href
        else if (href.startsWith('#') && document)
          target = helpHref(
            'manual',
            document.id,
            new URLSearchParams(`anchor=${href.slice(1).replace(/\+/g, '%2B')}`).get('anchor'),
          )
        else if (document && !/^(?:[a-z]+:|\/)/i.test(href)) {
          const url = new URL(href, `https://documentation.invalid/${document.sourcePath}`)
          const page = publicDocuments.find((p) => `/${p.sourcePath}` === decodeURIComponent(url.pathname))
          if (page) target = helpHref('manual', page.id, decodeURIComponent(url.hash.slice(1)))
        }
        if (target) {
          event.preventDefault()
          navigate(target)
        }
      }}
    >
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <Button
          aria-label="Help 메뉴"
          className="lg:hidden"
          size="icon"
          variant="ghost"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-expanded={menuOpen}
        >
          <Menu />
        </Button>
        <button className="flex items-center gap-2 font-semibold" onClick={() => navigate(helpHref('home'))}>
          <BookOpenText className="size-5 text-primary" />
          <span className="hidden sm:inline">Help</span>
        </button>
        <label className="relative mx-auto w-full max-w-2xl">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
          <Input
            aria-label="Help 전체 검색"
            type="search"
            placeholder="무엇을 하고 싶으신가요? 문서, 문법, 단위, Solver 검색"
            className="pl-9"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <Button aria-label="Help 닫기" size="sm" variant="ghost" onClick={onClose}>
          <X className="size-4" />
          <span className="hidden sm:inline">작업으로 돌아가기</span>
        </Button>
      </header>
      <div className="relative flex min-h-0 flex-1">
        <aside
          className={`${menuOpen ? 'absolute inset-y-0 left-0 z-20 shadow-xl' : 'hidden'} w-64 shrink-0 overflow-auto border-r bg-background p-3 lg:static lg:block lg:shadow-none`}
        >
          <nav aria-label="Help 탐색" className="space-y-4">
            <a
              href={helpHref('home')}
              aria-current={kind === 'home' ? 'page' : undefined}
              className="block rounded-md px-3 py-2 font-medium hover:bg-muted"
            >
              Help 홈
            </a>
            {journeys.map((group) => (
              <details key={group.title} open={journey?.title === group.title}>
                <summary className="cursor-pointer px-2 py-2 text-sm font-semibold">{group.title}</summary>
                <div className="mt-1 space-y-1">
                  {group.ids
                    .map((id) => publicDocuments.find((p) => p.id === id))
                    .filter((p) => p !== undefined)
                    .map((page) => (
                      <a
                        key={page.id}
                        href={helpHref('manual', page.id)}
                        aria-current={item === page.id ? 'page' : undefined}
                        className={`block rounded-md px-3 py-2 text-xs leading-5 hover:bg-muted ${item === page.id ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`}
                      >
                        {page.title}
                      </a>
                    ))}
                </div>
              </details>
            ))}
            <details open={kind === 'manual' && !journey}>
              <summary className="cursor-pointer px-2 py-2 text-sm font-semibold">API Reference·추가 가이드</summary>
              {publicDocuments
                .filter((p) => !journeys.some((g) => g.ids.includes(p.id)))
                .map((page) => (
                  <a
                    key={page.id}
                    href={helpHref('manual', page.id)}
                    aria-current={item === page.id ? 'page' : undefined}
                    className={`block rounded-md px-3 py-2 text-xs leading-5 hover:bg-muted ${item === page.id ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`}
                  >
                    {page.title}
                  </a>
                ))}
            </details>
            <div className="border-t pt-3">
              <p className="px-2 text-xs font-semibold text-muted-foreground">카탈로그·예제</p>
              {catalogs.map((catalog) => (
                <a
                  key={catalog.kind}
                  href={helpHref(catalog.kind)}
                  aria-current={kind === catalog.kind ? 'page' : undefined}
                  className={`mt-1 block rounded-md px-3 py-2 text-sm hover:bg-muted ${kind === catalog.kind ? 'bg-primary/10 text-primary' : ''}`}
                >
                  {catalog.label}
                </a>
              ))}
            </div>
          </nav>
        </aside>
        <div ref={contentRef} className="min-w-0 flex-1 overflow-auto" aria-label="Help 본문">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3 text-xs text-muted-foreground">
            <span>{kind === 'home' ? 'Help 홈' : `Help / ${journey?.title ? `${journey.title} / ` : ''}${title}`}</span>
            <CopyButton label="링크 복사" text={new URL(helpHref(kind, item, anchor), window.location.origin).href} />
          </div>
          {query.trim() ? (
            <div className="mx-auto max-w-5xl space-y-6 p-5 sm:p-8" aria-live="polite">
              <h1 className="text-2xl font-semibold">검색 결과</h1>
              {query.trim() !== settledQuery || catalogSearch.isFetching ? (
                <p role="status" className="text-sm text-muted-foreground">
                  검색 중…
                </p>
              ) : null}
              {catalogSearch.isError ? (
                <div className="rounded-lg border p-4 text-sm">
                  카탈로그 검색을 불러오지 못했습니다. 매뉴얼과 Geometry 결과는 계속 이용할 수 있습니다.{' '}
                  <Button variant="outline" size="sm" onClick={() => void catalogSearch.refetch()}>
                    다시 시도
                  </Button>
                </div>
              ) : null}
              {!results.length && query.trim() === settledQuery ? (
                <p>일치하는 문서가 없습니다. 다른 이름이나 단위로 검색해 보세요.</p>
              ) : null}
              {[...new Set(results.map((r) => r.section))].map((section) => (
                <section key={section} className="space-y-2">
                  <h2 className="font-semibold">
                    {catalogs.find((c) => c.kind === section)?.label ?? '매뉴얼'} · {section}
                  </h2>
                  {results
                    .filter((r) => r.section === section)
                    .slice(0, 20)
                    .map((result) => {
                      const plain = result.content.replace(/[`#*]/g, '')
                      const index = plain.toLocaleLowerCase().indexOf(settledQuery.toLocaleLowerCase())
                      const snippet = index >= 0 ? plain.slice(Math.max(0, index - 45), index + 160) : result.summary
                      return (
                        <a href={result.href} key={result.id} className="block rounded-lg border p-4 hover:bg-muted">
                          <span className="font-medium text-primary">{result.title}</span>
                          <span className="mt-1 line-clamp-3 block text-sm text-muted-foreground">{snippet}</span>
                        </a>
                      )
                    })}
                  {results.filter((r) => r.section === section).length > 20 ? (
                    <p className="text-xs text-muted-foreground">
                      상위 20개를 표시합니다. 검색어를 구체적으로 입력해 주세요.
                    </p>
                  ) : null}
                </section>
              ))}
            </div>
          ) : kind === 'home' ? (
            <div className="mx-auto max-w-5xl p-5 sm:p-8">
              <p className="text-sm font-medium text-primary">CAE Workbench 안내</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight">하고 싶은 작업에서 시작하세요</h1>
              <p className="mt-3 text-muted-foreground">
                처음 실행부터 결과 해석까지, 필요한 단계와 정확한 문법을 한곳에서 찾으세요.
              </p>
              <div className="mt-8 grid gap-4 md:grid-cols-2">
                {journeys.map((group, index) => (
                  <a
                    key={group.title}
                    href={helpHref('manual', group.ids[0])}
                    className="group rounded-xl border p-5 transition-colors hover:bg-muted"
                  >
                    <span className="text-xs font-medium text-primary">0{index + 1}</span>
                    <h2 className="mt-3 flex items-center justify-between text-lg font-semibold">
                      {group.title}
                      <ArrowRight className="size-4" />
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">{group.summary}</p>
                  </a>
                ))}
              </div>
              <h2 className="mt-9 font-semibold">문법·규격·예제 바로 찾기</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {catalogs.map((c) => (
                  <Button key={c.kind} asChild variant="outline">
                    <a href={helpHref(c.kind)}>{c.label}</a>
                  </Button>
                ))}
                <Button asChild variant="outline">
                  <a href={helpHref('manual', 'reference-core-api')}>API Reference</a>
                </Button>
              </div>
            </div>
          ) : kind === 'manual' ? (
            document ? (
              <article className="mx-auto max-w-5xl p-5 sm:p-8">
                <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{document.title}</h1>
                <p className="mt-3 leading-7 text-muted-foreground">{document.summary}</p>
                {headings.length ? (
                  <nav aria-label="문서 목차" className="my-6 rounded-lg border bg-muted/30 p-4">
                    <p className="mb-2 text-sm font-semibold">이 문서에서</p>
                    {headings.map((h) => (
                      <a
                        href={helpHref('manual', document.id, h.id)}
                        key={h.id}
                        className={`block py-1 text-sm text-primary hover:underline ${h.level > 2 ? 'pl-4' : ''}`}
                      >
                        {h.title}
                      </a>
                    ))}
                  </nav>
                ) : null}
                <div className="help-markdown mt-6 min-w-0 text-sm leading-7 [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-6 [&_h3]:font-semibold [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-4 [&_pre]:max-h-[560px] [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_td]:border [&_td]:p-3 [&_th]:border [&_th]:bg-muted [&_th]:p-3 [&_ul]:list-disc [&_ul]:pl-6">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h2: ({ node, children }) =>
                        createElement(
                          'h2',
                          {
                            id: headings.find((h) => h.line === node?.position?.start.line)?.id,
                            className: 'scroll-mt-4',
                          },
                          children,
                        ),
                      h3: ({ node, children }) =>
                        createElement(
                          'h3',
                          {
                            id: headings.find((h) => h.line === node?.position?.start.line)?.id,
                            className: 'scroll-mt-4',
                          },
                          children,
                        ),
                      h4: ({ node, children }) =>
                        createElement(
                          'h4',
                          {
                            id: headings.find((h) => h.line === node?.position?.start.line)?.id,
                            className: 'scroll-mt-4',
                          },
                          children,
                        ),
                      table: ({ children }) => (
                        <div className="my-4 overflow-x-auto">
                          <table className="w-full border-collapse">{children}</table>
                        </div>
                      ),
                      pre: ({ node, children }) => (
                        <div className="my-4 min-w-0">
                          <div className="mb-1 flex justify-end">
                            <CopyButton
                              text={
                                node?.children
                                  .flatMap((child) =>
                                    child.type === 'element'
                                      ? child.children.flatMap((text) => (text.type === 'text' ? text.value : []))
                                      : [],
                                  )
                                  .join('') ?? ''
                              }
                            />
                          </div>
                          <pre>{children}</pre>
                        </div>
                      ),
                    }}
                  >
                    {document.content}
                  </ReactMarkdown>
                </div>
                <footer className="mt-10 border-t pt-5">
                  <h2 className="font-semibold">관련 문서</h2>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {related
                      .filter((id) => id !== document.id)
                      .map((id) => publicDocuments.find((p) => p.id === id))
                      .filter((p) => p !== undefined)
                      .map((page) => (
                        <a
                          key={page.id}
                          href={helpHref('manual', page.id)}
                          className="rounded-md border px-3 py-2 text-sm hover:bg-muted"
                        >
                          {page.title}
                        </a>
                      ))}
                  </div>
                  {next ? (
                    <a
                      className="mt-5 flex items-center gap-2 font-medium text-primary"
                      href={helpHref('manual', next)}
                    >
                      다음 단계: {publicDocuments.find((p) => p.id === next)?.title}
                      <ArrowRight className="size-4" />
                    </a>
                  ) : null}
                </footer>
              </article>
            ) : (
              <div className="p-8">
                <h1 className="text-xl font-semibold">문서를 찾을 수 없습니다</h1>
                <p className="my-3 text-muted-foreground">문서가 이동했거나 주소가 올바르지 않습니다.</p>
                <Button onClick={() => navigate(helpHref('home'))}>
                  <ArrowLeft />
                  Help 홈으로
                </Button>
              </div>
            )
          ) : (
            <Suspense
              fallback={
                <p className="p-8" role="status">
                  카탈로그를 불러오는 중…
                </p>
              }
            >
              {kind === 'geometry' ? (
                <GeometryCatalog
                  embedded
                  selectedKey={item}
                  onSelectedKeyChange={(key) => navigate(helpHref(kind, key))}
                />
              ) : kind === 'materials' ? (
                <MaterialCatalog
                  embedded
                  selectedKey={item}
                  onSelectedKeyChange={(key) => navigate(helpHref(kind, key))}
                />
              ) : kind === 'quantity-kinds' ? (
                <QuantityCatalog
                  embedded
                  selectedKey={item}
                  onSelectedKeyChange={(key) => navigate(helpHref(kind, key))}
                />
              ) : kind === 'examples' ? (
                <ExampleCatalog
                  embedded
                  selectedKey={item}
                  onSelect={(key) => navigate(helpHref('examples', key))}
                  onSelectSolver={(name, version) => navigate(helpHref('solvers', `${name}@${version}`))}
                />
              ) : (
                <PhysicsCatalog
                  embedded
                  selectedKey={item}
                  onSelectedKeyChange={(key) =>
                    navigate(
                      key.startsWith('experiment:') ? helpHref('examples', key.slice(11)) : helpHref('solvers', key),
                    )
                  }
                />
              )}
              <div className="px-6 pb-6">
                <Button variant="ghost" onClick={() => navigate(helpHref(kind))}>
                  <ArrowLeft className="size-4" />
                  목록으로
                </Button>
              </div>
            </Suspense>
          )}
        </div>
      </div>
    </section>
  )
}
