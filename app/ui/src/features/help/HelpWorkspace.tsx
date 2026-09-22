import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, BookOpenText, ChevronRight, Menu, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { CopyButton } from '@/components/CopyButton'
import { catalogSearchQueryOptions } from '@/features/catalog/queryOptions'
import { catalogSearchKnowledge, getDocsKnowledge, searchDocsKnowledge } from '@/documentation/knowledge'
import { documentationCatalogs, documentationGroups } from '@/documentation/navigation'
import { publicDocuments } from '@/documentation/public'
import { helpHref, type HelpKindId } from '@/documentation/helpNavigation'
import { useDebouncedValue } from '@/shared/useDebouncedValue'
import { HelpArticle } from './HelpArticle'
import { HelpCatalog } from './HelpCatalog'
import { HelpHome } from './HelpHome'
import { HelpNavigation } from './HelpNavigation'
import { HelpSearch } from './HelpSearch'
import './help.css'

const localKnowledge = getDocsKnowledge()

function scrollDocument(content: HTMLDivElement | null, anchor: string | null) {
  const target = anchor
    ? [...(content?.querySelectorAll<HTMLElement>('[id]') ?? [])].find((node) => node.id === anchor)
    : undefined
  if (target) {
    target.focus({ preventScroll: true })
    target.scrollIntoView?.({ block: 'start' })
  } else content?.scrollTo?.(0, 0)
}

export function HelpWorkspace({
  kind,
  item,
  anchor,
  onNavigate,
}: {
  kind: HelpKindId
  item: string | null
  anchor: string | null
  onNavigate: (href: string) => void
}) {
  const [query, setQuery] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const locationKey = `${kind}/${item ?? ''}/${anchor ?? ''}`
  const [previousLocation, setPreviousLocation] = useState(locationKey)
  // History navigation should reveal the requested document, even during a search.
  if (previousLocation !== locationKey) {
    setPreviousLocation(locationKey)
    setQuery('')
    setMenuOpen(false)
  }
  const settledQuery = useDebouncedValue(query.trim())
  const searching = Boolean(query.trim())
  const catalogSearch = useQuery(catalogSearchQueryOptions(settledQuery, 100, searching && Boolean(settledQuery)))
  const results = useMemo(
    () => searchDocsKnowledge(settledQuery, [...localKnowledge, ...catalogSearchKnowledge(catalogSearch.data ?? [])]),
    [settledQuery, catalogSearch.data],
  )
  const document = kind === 'manual' ? publicDocuments.find((page) => page.id === item) : undefined
  const group = documentationGroups.find(({ ids }) => ids.some((id) => id === item))
  const title =
    kind === 'home'
      ? '가이드 홈'
      : kind === 'manual'
        ? (document?.title ?? '문서를 찾을 수 없습니다')
        : documentationCatalogs.find((catalog) => catalog.kind === kind)?.label
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollDocument(contentRef.current, searching ? null : anchor)
  }, [kind, item, anchor, searching])

  const navigate = (href: string) => {
    setQuery('')
    setMenuOpen(false)
    if (href === helpHref(kind, item, anchor)) {
      scrollDocument(contentRef.current, anchor)
      return
    }
    onNavigate(href)
  }

  return (
    <section
      aria-label="Caemble 사용 가이드"
      className="documentation flex h-full min-h-0 flex-col bg-background text-foreground"
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
        const link = (event.target as Element).closest('a[href]')
        const href = link?.getAttribute('href')
        if (!href?.startsWith('/doc?help=') || link?.getAttribute('target') === '_blank') return
        event.preventDefault()
        navigate(href)
      }}
    >
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3 sm:gap-5 sm:px-6">
        <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
          <DialogTrigger asChild>
            <Button aria-label="가이드 메뉴 열기" className="shrink-0 lg:hidden" size="icon" variant="ghost">
              <Menu />
            </Button>
          </DialogTrigger>
          <DialogContent className="inset-y-0 left-0 flex h-dvh w-80 max-w-[calc(100%-2rem)] translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-y-0 border-l-0 p-0 sm:max-w-80">
            <div className="border-b px-7 pt-6 pb-4">
              <DialogTitle>사용 가이드</DialogTitle>
              <DialogDescription className="mt-2">읽고 싶은 주제를 선택하세요.</DialogDescription>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <HelpNavigation kind={kind} item={item} />
            </div>
          </DialogContent>
        </Dialog>
        <a
          aria-label="사용 가이드 홈"
          href={helpHref('home')}
          className="flex shrink-0 items-center gap-2.5 rounded-md font-semibold"
        >
          <BookOpenText className="size-5 text-primary" aria-hidden="true" />
          <span className="hidden sm:inline">사용 가이드</span>
        </a>
        <div className="relative ml-auto w-full max-w-xl min-w-0">
          <Search
            className="pointer-events-none absolute top-3 left-3.5 size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            aria-label="사용 가이드 전체 검색"
            type="search"
            placeholder="궁금한 내용 검색"
            className="h-10 rounded-lg bg-muted/35 pr-10 pl-10 shadow-none [&::-webkit-search-cancel-button]:hidden"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('')
            }}
          />
          {query ? (
            <button
              aria-label="검색어 지우기"
              className="absolute inset-y-0 right-0 grid w-10 place-items-center rounded-r-lg text-muted-foreground hover:text-foreground"
              onClick={() => setQuery('')}
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 overflow-y-auto border-r bg-muted/15 lg:block">
          <HelpNavigation kind={kind} item={item} />
        </aside>
        <div ref={contentRef} className="min-w-0 flex-1 overflow-auto" aria-label="사용 가이드 본문">
          <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3 sm:px-9">
            <nav aria-label="현재 위치" className="min-w-0 text-xs text-muted-foreground">
              <ol className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <li>
                  <a
                    href={helpHref('home')}
                    className="hover:text-primary"
                    aria-current={!searching && kind === 'home' ? 'page' : undefined}
                  >
                    가이드 홈
                  </a>
                </li>
                {searching ? (
                  <li className="flex items-center gap-2">
                    <ChevronRight className="size-3" aria-hidden="true" />
                    <span aria-current="page">검색 결과</span>
                  </li>
                ) : kind !== 'home' ? (
                  <>
                    {group ? (
                      <li className="hidden items-center gap-2 sm:flex">
                        <ChevronRight className="size-3" aria-hidden="true" />
                        <a href={helpHref('manual', group.ids[0])} className="hover:text-primary">
                          {group.title}
                        </a>
                      </li>
                    ) : null}
                    <li className="flex min-w-0 items-center gap-2">
                      <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
                      <span aria-current="page" className="line-clamp-1">
                        {title}
                      </span>
                    </li>
                  </>
                ) : null}
              </ol>
            </nav>
            {!searching && kind !== 'home' ? (
              <div className="shrink-0">
                <CopyButton
                  label="링크 복사"
                  text={new URL(helpHref(kind, item, anchor), window.location.origin).href}
                />
              </div>
            ) : null}
          </div>
          {searching ? (
            <HelpSearch
              query={query.trim()}
              results={query.trim() === settledQuery ? results : []}
              pending={query.trim() !== settledQuery || catalogSearch.isFetching}
              failed={query.trim() === settledQuery && catalogSearch.isError}
              onRetry={() => void catalogSearch.refetch()}
              onQueryChange={setQuery}
            />
          ) : kind === 'home' ? (
            <HelpHome />
          ) : kind === 'manual' ? (
            document ? (
              <HelpArticle document={document} anchor={anchor} />
            ) : (
              <div className="mx-auto max-w-2xl px-6 py-16">
                <BookOpenText className="mb-5 size-8 text-muted-foreground" aria-hidden="true" />
                <h1 className="text-2xl font-semibold">문서를 찾을 수 없습니다</h1>
                <p className="mt-3 mb-6 leading-7 text-muted-foreground">
                  주소를 다시 확인하거나, 위 검색창에서 필요한 내용을 찾아보세요.
                </p>
                <Button asChild>
                  <a href={helpHref('home')}>
                    <ArrowLeft /> 가이드 홈으로
                  </a>
                </Button>
              </div>
            )
          ) : (
            <HelpCatalog kind={kind} item={item} onNavigate={navigate} />
          )}
        </div>
      </div>
    </section>
  )
}
