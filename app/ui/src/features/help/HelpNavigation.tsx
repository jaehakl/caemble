import { ChevronRight, House } from 'lucide-react'
import { helpHref, type HelpKindId } from '@/documentation/helpNavigation'
import { documentationCatalogs, documentationGroups } from '@/documentation/navigation'
import { publicDocuments } from '@/documentation/public'

export function HelpNavigation({ kind, item }: { kind: HelpKindId; item: string | null }) {
  return (
    <nav aria-label="사용 가이드 탐색" className="space-y-5 px-4 py-5">
      <a
        href={helpHref('home')}
        aria-current={kind === 'home' ? 'page' : undefined}
        className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium ${kind === 'home' ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'}`}
      >
        <House className="size-4" aria-hidden="true" /> 가이드 홈
      </a>
      <div className="space-y-2">
        {documentationGroups.map((group, index) => (
          <details
            key={group.title}
            className="group/navigation"
            open={group.ids.some((id) => id === item) || (kind === 'home' && index === 0)}
          >
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-2 text-sm font-semibold hover:text-primary [&::-webkit-details-marker]:hidden">
              <ChevronRight
                className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/navigation:rotate-90"
                aria-hidden="true"
              />
              {group.title}
            </summary>
            <div className="ml-3 space-y-0.5 border-l py-1 pl-2">
              {group.ids
                .map((id) => publicDocuments.find((page) => page.id === id))
                .filter((page) => page !== undefined)
                .map((page) => (
                  <a
                    key={page.id}
                    href={helpHref('manual', page.id)}
                    aria-current={item === page.id ? 'page' : undefined}
                    className={`block rounded-md px-3 py-2 text-[13px] leading-5 ${item === page.id ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                  >
                    {page.title}
                  </a>
                ))}
            </div>
          </details>
        ))}
      </div>
      <div className="border-t pt-5">
        <p className="mb-2 px-3 text-xs font-medium tracking-wide text-muted-foreground">카탈로그와 예제</p>
        {documentationCatalogs.map(({ kind: catalogKind, label }) => (
          <a
            key={catalogKind}
            href={helpHref(catalogKind)}
            aria-current={kind === catalogKind ? 'page' : undefined}
            className={`block rounded-md px-3 py-2 text-[13px] leading-5 ${kind === catalogKind ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
          >
            {label}
          </a>
        ))}
      </div>
    </nav>
  )
}
