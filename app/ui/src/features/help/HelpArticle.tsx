import { ArrowLeft, ArrowRight, ChevronDown, List } from 'lucide-react'
import { createElement, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CopyButton } from '@/components/CopyButton'
import { documentHeadings, type DocumentHeading } from '@/documentation/headings'
import { helpHref } from '@/documentation/helpNavigation'
import { documentationLink } from '@/documentation/links'
import { documentationGroups } from '@/documentation/navigation'
import { publicDocuments } from '@/documentation/public'
import type { DocumentPage } from '@/documentation/types'

function DocumentOutline({
  document,
  headings,
  anchor,
}: {
  document: DocumentPage
  headings: DocumentHeading[]
  anchor: string | null
}) {
  return (
    <nav aria-label="문서 목차" className="space-y-1">
      {headings.map((heading) => (
        <a
          key={heading.id}
          href={helpHref('manual', document.id, heading.id)}
          aria-current={anchor === heading.id ? 'location' : undefined}
          className={`block border-l py-1.5 pr-2 text-[13px] leading-5 transition-colors hover:text-primary ${heading.level === 2 ? 'pl-3' : heading.level === 3 ? 'pl-6' : 'pl-9'} ${anchor === heading.id ? 'border-primary font-medium text-primary' : 'border-border text-muted-foreground'}`}
        >
          {heading.title}
        </a>
      ))}
    </nav>
  )
}

export function HelpArticle({ document, anchor }: { document: DocumentPage; anchor: string | null }) {
  const headings = useMemo(() => documentHeadings(document.content), [document.content])
  const group = documentationGroups.find(({ ids }) => ids.some((id) => id === document.id))
  const pages = (group?.ids ?? [])
    .map((id) => publicDocuments.find((page) => page.id === id))
    .filter((page) => page !== undefined)
  const index = pages.findIndex((page) => page.id === document.id)
  const previous = pages[index - 1]
  const next = pages[index + 1]
  const related = pages.filter((page) => page.id !== document.id && page !== previous && page !== next).slice(0, 3)
  return (
    <div className="mx-auto grid w-full max-w-[76rem] items-start gap-12 px-5 py-8 sm:px-9 sm:py-10 xl:grid-cols-[minmax(0,48rem)_minmax(10rem,1fr)] xl:gap-8 2xl:gap-12">
      <article className="mx-auto w-full max-w-3xl min-w-0">
        <header className="border-b pb-7">
          <p className="mb-3 text-sm font-medium text-primary">{group?.title ?? '사용 가이드'}</p>
          <h1 className="text-2xl leading-snug font-semibold tracking-tight text-balance sm:text-3xl">
            {document.title}
          </h1>
          <p className="mt-4 text-base leading-8 text-muted-foreground">{document.summary}</p>
        </header>
        {headings.length ? (
          <details className="group/outline mt-6 rounded-xl border bg-muted/25 px-4 py-3 xl:hidden">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
              <List className="size-4 text-primary" aria-hidden="true" /> 이 문서의 내용
              <ChevronDown
                className="ml-auto size-4 text-muted-foreground transition-transform group-open/outline:rotate-180"
                aria-hidden="true"
              />
            </summary>
            <div className="pt-3">
              <DocumentOutline document={document} headings={headings} anchor={anchor} />
            </div>
          </details>
        ) : null}
        <div className="help-markdown mt-7 min-w-0">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => <a href={href ? documentationLink(href, document) : undefined}>{children}</a>,
              h2: ({ node, children }) =>
                createElement(
                  'h2',
                  { id: headings.find((heading) => heading.line === node?.position?.start.line)?.id, tabIndex: -1 },
                  children,
                ),
              h3: ({ node, children }) =>
                createElement(
                  'h3',
                  { id: headings.find((heading) => heading.line === node?.position?.start.line)?.id, tabIndex: -1 },
                  children,
                ),
              h4: ({ node, children }) =>
                createElement(
                  'h4',
                  { id: headings.find((heading) => heading.line === node?.position?.start.line)?.id, tabIndex: -1 },
                  children,
                ),
              table: ({ children }) => (
                <div className="help-table" tabIndex={0} role="region" aria-label="표 · 좌우로 스크롤할 수 있습니다">
                  <table>{children}</table>
                </div>
              ),
              pre: ({ node, children }) => {
                const code = node?.children.find((child) => child.type === 'element')
                const language =
                  code?.type === 'element' ? String(code.properties?.className ?? '').replace('language-', '') : ''
                const source =
                  code?.type === 'element'
                    ? code.children.flatMap((child) => (child.type === 'text' ? child.value : [])).join('')
                    : ''
                return (
                  <div className="help-code">
                    <div className="help-code-toolbar">
                      <span>{language || '코드'}</span>
                      <CopyButton text={source} />
                    </div>
                    <pre tabIndex={0}>{children}</pre>
                  </div>
                )
              },
            }}
          >
            {document.content}
          </ReactMarkdown>
        </div>
        <footer className="mt-12 border-t pt-6">
          <nav aria-label="이전·다음 문서" className="grid gap-3 sm:grid-cols-2">
            {previous ? (
              <a
                href={helpHref('manual', previous.id)}
                className="rounded-xl border p-4 transition-colors hover:border-primary/30 hover:bg-accent/30"
              >
                <span className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <ArrowLeft className="size-3.5" /> 이전 문서
                </span>
                <span className="text-sm leading-6 font-medium">{previous.title}</span>
              </a>
            ) : (
              <div className="hidden sm:block" />
            )}
            {next ? (
              <a
                href={helpHref('manual', next.id)}
                className="rounded-xl border p-4 text-right transition-colors hover:border-primary/30 hover:bg-accent/30"
              >
                <span className="mb-2 flex items-center justify-end gap-2 text-xs text-primary">
                  다음 문서 <ArrowRight className="size-3.5" />
                </span>
                <span className="text-sm leading-6 font-medium">{next.title}</span>
              </a>
            ) : null}
          </nav>
          {related.length ? (
            <div className="mt-7">
              <h2 className="text-sm font-semibold">함께 읽으면 좋은 문서</h2>
              <ul className="mt-3 space-y-2">
                {related.map((page) => (
                  <li key={page.id}>
                    <a
                      className="text-sm leading-6 text-muted-foreground hover:text-primary"
                      href={helpHref('manual', page.id)}
                    >
                      {page.title} →
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </footer>
      </article>
      {headings.length ? (
        <aside className="sticky top-8 hidden max-h-[calc(100dvh-12rem)] overflow-y-auto pb-2 xl:block">
          <p className="mb-4 flex items-center gap-2 text-xs font-semibold">
            <List className="size-3.5 text-primary" aria-hidden="true" /> 이 문서의 내용
          </p>
          <DocumentOutline document={document} headings={headings} anchor={anchor} />
        </aside>
      ) : null}
    </div>
  )
}
