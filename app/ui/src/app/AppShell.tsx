import {
  BookOpenText,
  CircleUserRound,
  GalleryHorizontalEnd,
  PanelsTopLeft,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react'
import { NavLink, Outlet } from 'react-router'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAuth } from '@/features/auth/use-auth'
import { cn } from '@/lib/utils'

type NavigationItem = Readonly<{
  label: string
  path: string
  icon: LucideIcon
  adminOnly?: boolean
}>

const navigationItems: readonly NavigationItem[] = [
  { label: 'Showcase', path: '/showcase', icon: GalleryHorizontalEnd },
  { label: 'Workbench', path: '/workbench', icon: PanelsTopLeft },
  { label: 'Documentation', path: '/doc', icon: BookOpenText },
  { label: 'Admin', path: '/admin', icon: ShieldCheck, adminOnly: true },
  { label: 'Setting', path: '/settings', icon: Settings },
  { label: 'Account', path: '/account', icon: CircleUserRound },
]

export function AppShell() {
  const auth = useAuth()
  const admin = Boolean(auth.user?.roles.includes('admin'))

  return (
    <div className="flex h-dvh min-h-[560px] overflow-hidden bg-background text-foreground">
      <aside className="z-40 flex w-12 shrink-0 flex-col border-r bg-background" aria-label="애플리케이션 내비게이션">
        <nav className="flex flex-1 flex-col items-center gap-1 py-2">
          {navigationItems
            .filter((item) => !item.adminOnly || admin)
            .map((item) => {
              const Icon = item.icon
              return (
                <Tooltip key={item.path}>
                  <TooltipTrigger asChild>
                    <NavLink
                      aria-label={item.label}
                      className={({ isActive }) =>
                        cn(
                          'relative grid size-10 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring',
                          isActive &&
                            'bg-accent text-accent-foreground before:absolute before:top-2 before:bottom-2 before:left-[-4px] before:w-0.5 before:rounded-full before:bg-primary',
                        )
                      }
                      to={item.path}
                    >
                      <Icon aria-hidden="true" className="size-5" />
                    </NavLink>
                  </TooltipTrigger>
                  <TooltipContent side="right">{item.label}</TooltipContent>
                </Tooltip>
              )
            })}
        </nav>
      </aside>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  )
}
