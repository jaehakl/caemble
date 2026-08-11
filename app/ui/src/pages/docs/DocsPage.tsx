import { useQuery } from '@tanstack/react-query'
import {
  BookOpenText,
  Boxes,
  CircleAlert,
  Code2,
  ExternalLink,
  FlaskConical,
  Gauge,
  Home,
  Layers3,
  Menu,
  Search,
  Workflow,
} from 'lucide-react'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { caeSolverManifestsQueryKey, fetchCaeSolverManifests } from '@/features/cae/manifests'
import { GeometryCatalog } from '@/pages/catalog/cad/CadCatalogPage'
import { MaterialCatalog } from '@/pages/catalog/materials/MaterialCatalogPage'
import { QuantityCatalog } from '@/pages/catalog/quantity-kinds/QuantityKindCatalogPage'
import { PhysicsCatalog } from '@/pages/catalog/solvers/SolverCatalogPage'
import { defaultDocsSection, docsSectionIds, type DocsSectionId } from './docsRoute'
import { getDocsKnowledge, searchDocsKnowledge, type DocsKnowledgeChunk } from './docsKnowledge'
import { ManualDocsPage } from './ManualDocsPage'

const docsSections = [
  { id: 'workbench' as const, group: 'Manual' as const, label: 'Workbench Quickstart', icon: Home },
  { id: 'structure' as const, group: 'Manual' as const, label: 'Structure Authoring', icon: Code2 },
  { id: 'program' as const, group: 'Manual' as const, label: 'Experiment Program', icon: Workflow },
  { id: 'reference' as const, group: 'Manual' as const, label: 'API / CAD Reference', icon: BookOpenText },
  { id: 'troubleshooting' as const, group: 'Manual' as const, label: 'Troubleshooting', icon: CircleAlert },
  { id: 'geometry' as const, group: 'Catalogs' as const, label: 'Geometry Catalog', icon: Boxes },
  { id: 'materials' as const, group: 'Catalogs' as const, label: 'Material Catalog', icon: Layers3 },
  { id: 'quantity-kinds' as const, group: 'Catalogs' as const, label: 'Quantity Catalog', icon: Gauge },
  { id: 'solvers' as const, group: 'Catalogs' as const, label: 'Physics Catalog', icon: FlaskConical },
] as const

export function DocsPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const deferredSearchQuery = useDeferredValue(searchQuery)
  const sectionParam = searchParams.get('section')
  const section = docsSectionIds.find((candidate) => candidate === sectionParam) ?? defaultDocsSection
  const selectedItem = searchParams.get('item')
  const solverManifests = useQuery({
    queryKey: caeSolverManifestsQueryKey,
    queryFn: fetchCaeSolverManifests,
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
  })

  const searchEntries = useMemo<readonly DocsKnowledgeChunk[]>(
    () => getDocsKnowledge(solverManifests.data),
    [solverManifests.data],
  )

  const searchResults = useMemo(() => {
    const ranked = searchDocsKnowledge(deferredSearchQuery, searchEntries)

    return {
      total: ranked.length,
      groups: docsSections
        .map((docsSection) => {
          const matches = ranked.filter((entry) => entry.section === docsSection.id)
          return {
            id: docsSection.id,
            label: docsSection.label,
            entries: matches.slice(0, 20),
            total: matches.length,
          }
        })
        .filter(({ total }) => total > 0),
    }
  }, [deferredSearchQuery, searchEntries])

  const searchActive = deferredSearchQuery.trim().length > 0

  useEffect(() => {
    if (!location.hash || searchActive) return
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(location.hash.slice(1))?.scrollIntoView?.({ block: 'start' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [location.hash, searchActive, section])

  const openSection = (nextSection: DocsSectionId, item?: string, anchor?: string) => {
    const params = new URLSearchParams({ section: nextSection })
    if (item) params.set('item', item)
    navigate({ pathname: '/docs', search: `?${params.toString()}`, hash: anchor ? `#${anchor}` : '' })
    setMobileNavigationOpen(false)
  }

  const selectCatalogItem = (key: string) => {
    const params = new URLSearchParams({ section })
    params.set('item', key)
    navigate({ pathname: '/docs', search: `?${params.toString()}` }, { replace: true })
  }

  return (
    <div className="min-h-dvh bg-slate-50 text-slate-950">
      <header className="sticky top-0 z-40 border-b bg-white/95 backdrop-blur">
        <div className="mx-auto flex min-h-16 max-w-[1800px] items-center gap-3 px-3 sm:px-5">
          <Button
            aria-label="문서 메뉴 열기"
            className="lg:hidden"
            size="icon"
            type="button"
            variant="ghost"
            onClick={() => setMobileNavigationOpen(true)}
          >
            <Menu />
          </Button>
          <Link className="hidden shrink-0 font-semibold sm:block" to="/docs">
            Caemble Documentation
          </Link>
          <div className="relative min-w-0 flex-1 sm:mx-auto sm:max-w-2xl">
            <Search aria-hidden="true" className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <Input
              aria-label="문서 전체 검색"
              className="bg-white pl-9"
              placeholder="매뉴얼 목차와 모든 카탈로그 검색"
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
          <Button asChild className="shrink-0" size="sm" variant="outline">
            <Link to="/">
              <span className="hidden sm:inline">CAE Workbench</span>
              <ExternalLink className="size-4" />
            </Link>
          </Button>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1800px] lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] overflow-auto border-r bg-white p-4 lg:block">
          <DocsNavigation activeSection={section} onSelect={openSection} />
        </aside>

        <main className="min-h-[calc(100dvh-4rem)] min-w-0 bg-white" id="docs-main">
          {searchActive ? (
            <section aria-labelledby="docs-search-results" className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
              <div className="border-b pb-5">
                <p className="text-xs font-semibold tracking-[0.16em] text-orange-700 uppercase">Global Search</p>
                <h1 className="mt-2 text-2xl font-semibold" id="docs-search-results">
                  검색 결과 {searchResults.total.toLocaleString()}개
                </h1>
                <p className="mt-2 text-sm text-slate-600">
                  “{deferredSearchQuery.trim()}”와 일치하는 매뉴얼 목차 및 카탈로그 항목입니다.
                </p>
              </div>

              {searchResults.groups.length ? (
                <div className="mt-6 space-y-8">
                  {searchResults.groups.map((group) => (
                    <section aria-labelledby={`docs-search-group-${group.id}`} key={group.id}>
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <h2 className="font-semibold" id={`docs-search-group-${group.id}`}>
                          {group.label}
                        </h2>
                        <span className="text-xs text-slate-500">{group.total.toLocaleString()}개 일치</span>
                      </div>
                      <div className="overflow-hidden rounded-xl border bg-white">
                        {group.entries.map((entry) => (
                          <button
                            aria-label={`${group.label}: ${entry.title}`}
                            className="flex w-full items-start justify-between gap-4 border-b px-4 py-3 text-left transition-colors last:border-0 hover:bg-orange-50 focus-visible:bg-orange-50 focus-visible:outline-none"
                            key={entry.id}
                            type="button"
                            onClick={() => {
                              setSearchQuery('')
                              openSection(entry.section, entry.item, entry.anchor)
                            }}
                          >
                            <span className="min-w-0">
                              <span className="block font-mono text-sm font-semibold break-all text-orange-800">
                                {entry.title}
                              </span>
                              <span className="mt-1 block text-sm text-slate-600">{entry.summary}</span>
                            </span>
                            <ExternalLink className="mt-0.5 size-4 shrink-0 text-slate-400" />
                          </button>
                        ))}
                      </div>
                      {group.total > group.entries.length ? (
                        <p className="mt-2 text-xs text-slate-500">
                          상위 {group.entries.length}개만 표시합니다. 검색어를 더 구체적으로 입력해 주세요.
                        </p>
                      ) : null}
                    </section>
                  ))}
                </div>
              ) : (
                <div className="mt-12 rounded-xl border border-dashed p-10 text-center">
                  <Search className="mx-auto size-8 text-slate-400" />
                  <p className="mt-3 font-medium">일치하는 문서나 카탈로그 항목이 없습니다.</p>
                  <p className="mt-1 text-sm text-slate-500">다른 이름, key 또는 단위로 검색해 보세요.</p>
                </div>
              )}

              {solverManifests.isError ? (
                <p className="mt-6 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  Solver manifest를 읽지 못해 Physics Catalog 항목은 검색 결과에서 제외했습니다.
                </p>
              ) : null}
            </section>
          ) : section === 'workbench' ||
            section === 'structure' ||
            section === 'program' ||
            section === 'reference' ||
            section === 'troubleshooting' ? (
            <ManualDocsPage section={section} />
          ) : section === 'geometry' ? (
            <GeometryCatalog embedded onSelectedKeyChange={selectCatalogItem} selectedKey={selectedItem} />
          ) : section === 'materials' ? (
            <MaterialCatalog embedded onSelectedKeyChange={selectCatalogItem} selectedKey={selectedItem} />
          ) : section === 'quantity-kinds' ? (
            <QuantityCatalog embedded onSelectedKeyChange={selectCatalogItem} selectedKey={selectedItem} />
          ) : (
            <PhysicsCatalog embedded onSelectedKeyChange={selectCatalogItem} selectedKey={selectedItem} />
          )}
        </main>
      </div>

      <Sheet open={mobileNavigationOpen} onOpenChange={setMobileNavigationOpen}>
        <SheetContent className="gap-0 p-0" side="left">
          <SheetHeader className="border-b px-5 py-4 pr-12">
            <SheetTitle>Caemble Documentation</SheetTitle>
            <SheetDescription>매뉴얼과 카탈로그 섹션을 선택하세요.</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <DocsNavigation activeSection={section} onSelect={openSection} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}

function DocsNavigation({
  activeSection,
  onSelect,
}: {
  activeSection: DocsSectionId
  onSelect: (section: DocsSectionId) => void
}) {
  return (
    <nav aria-label="문서 섹션" className="space-y-6">
      {(['Manual', 'Catalogs'] as const).map((group) => (
        <div key={group}>
          <p className="mb-2 px-2 text-xs font-semibold tracking-[0.14em] text-slate-500 uppercase">{group}</p>
          <div className="space-y-1">
            {docsSections
              .filter((section) => section.group === group)
              .map((section) => {
                const Icon = section.icon
                const active = activeSection === section.id
                return (
                  <Button
                    aria-current={active ? 'page' : undefined}
                    className="w-full justify-start"
                    key={section.id}
                    type="button"
                    variant={active ? 'secondary' : 'ghost'}
                    onClick={() => onSelect(section.id)}
                  >
                    <Icon />
                    {section.label}
                  </Button>
                )
              })}
          </div>
        </div>
      ))}
    </nav>
  )
}

export const Component = DocsPage
