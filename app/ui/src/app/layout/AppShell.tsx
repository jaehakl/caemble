import { LoaderCircle, LogIn, LogOut, Menu, Settings } from 'lucide-react'
import { useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate, useNavigation } from 'react-router'
import { toast } from 'sonner'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth, useLogout } from '@/features/auth/use-auth'
import { cn } from '@/lib/utils'
import { brandIcon as BrandIcon, catalogNavigation, primaryNavigation, type AppNavigationItem } from './app-navigation'

function navigationLinkClass(active: boolean, pending: boolean) {
  return cn(
    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
    active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
    pending && 'bg-muted text-foreground',
  )
}

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const items = (navigation: readonly AppNavigationItem[]) =>
    navigation.map(({ href, icon: Icon, label }) => (
      <NavLink
        className={({ isActive, isPending }) => navigationLinkClass(isActive, isPending)}
        end={href === '/'}
        key={href}
        onClick={onNavigate}
        to={href}
      >
        {({ isPending }) => (
          <>
            <Icon className="size-4" />
            {label}
            {isPending ? <LoaderCircle aria-hidden="true" className="ml-auto size-3.5 animate-spin" /> : null}
          </>
        )}
      </NavLink>
    ))

  return (
    <nav aria-label="주요 탐색" className="flex flex-col gap-1">
      {items(primaryNavigation)}
      <div className="mt-5 mb-1 px-3 text-[11px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
        카탈로그
      </div>
      {items(catalogNavigation)}
    </nav>
  )
}

function AccountMenu() {
  const navigate = useNavigate()
  const { isAuthenticated, isLoading, user } = useAuth()
  const logoutMutation = useLogout()

  if (isLoading) return <div aria-label="계정 불러오는 중" className="size-8 animate-pulse rounded-full bg-muted" />
  if (!isAuthenticated || !user) {
    return (
      <Button asChild size="sm" variant="outline">
        <Link to="/login">
          <LogIn />
          로그인
        </Link>
      </Button>
    )
  }

  const label = user.display_name || user.email || '사용자'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label="계정 메뉴" className="gap-2 px-2" variant="ghost">
          <Avatar>
            <AvatarImage alt="" src={user.picture_url ?? undefined} />
            <AvatarFallback>{label.slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="hidden max-w-36 truncate text-sm sm:inline">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <span className="block truncate text-foreground">{label}</span>
          <span className="block truncate font-normal">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/account')}>
          <Settings />
          계정
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={logoutMutation.isPending}
          onSelect={() =>
            logoutMutation.mutate(undefined, {
              onError: () => toast.error('로그아웃하지 못했습니다.'),
              onSuccess: () => {
                toast.success('로그아웃했습니다.')
                navigate('/')
              },
            })
          }
        >
          <LogOut />
          로그아웃
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function pageTitle(pathname: string) {
  if (pathname === '/') return '홈'
  if (pathname.startsWith('/structures')) return 'Structures'
  if (pathname.startsWith('/experiments')) return 'Experiments'
  if (pathname.startsWith('/examples')) return 'Examples Playground'
  if (pathname.startsWith('/measurements')) return 'Measurements'
  if (pathname.startsWith('/analysis')) return 'Analysis'
  if (pathname.startsWith('/materials')) return 'Materials'
  if (pathname.startsWith('/catalog/cad')) return 'Geometry'
  if (pathname.startsWith('/catalog/materials')) return 'Material Catalog'
  if (pathname.startsWith('/catalog/quantity-kinds')) return 'Quantity Kind'
  if (pathname.startsWith('/catalog/solvers')) return 'Physics Solver'
  if (pathname.startsWith('/docs')) return 'How to Code'
  if (pathname.startsWith('/account')) return '계정'
  if (pathname.startsWith('/login')) return '로그인'
  return 'Caemble'
}

export function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()
  const navigation = useNavigation()
  const pendingPathname = navigation.location?.pathname
  const displayedPathname = pendingPathname ?? location.pathname
  const workspace =
    displayedPathname === '/structures' ||
    displayedPathname === '/experiments' ||
    displayedPathname.startsWith('/examples')
  const segments = location.pathname.split('/').filter(Boolean)
  const pendingSegments = pendingPathname?.split('/').filter(Boolean)
  const pendingCatalog =
    navigation.state !== 'idle' && pendingSegments?.[0] === 'catalog' && pendingSegments[1] !== segments[1]
  const outletKey = segments[0] === 'catalog' ? `catalog/${segments[1] ?? ''}` : (segments[0] ?? 'home')

  return (
    <div className="flex h-dvh min-h-[600px] overflow-hidden bg-background text-foreground">
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-background px-3 py-4 lg:flex">
        <Link className="mb-7 flex items-center gap-3 px-2" to="/">
          <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <BrandIcon className="size-5" />
          </span>
          <span>
            <strong className="block text-base leading-5">Caemble</strong>
          </span>
        </Link>
        <Navigation />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b bg-background/95 px-3 backdrop-blur sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <Sheet onOpenChange={setMenuOpen} open={menuOpen}>
              <SheetTrigger asChild>
                <Button aria-label="메뉴 열기" className="lg:hidden" size="icon" variant="ghost">
                  <Menu />
                </Button>
              </SheetTrigger>
              <SheetContent className="w-72" side="left">
                <SheetHeader>
                  <SheetTitle className="flex items-center gap-2">
                    <BrandIcon className="text-primary" />
                    Caemble
                  </SheetTitle>
                  <SheetDescription>페이지와 카탈로그를 탐색하세요.</SheetDescription>
                </SheetHeader>
                <Navigation onNavigate={() => setMenuOpen(false)} />
              </SheetContent>
            </Sheet>
            <h1 className="truncate text-sm font-semibold sm:text-base">{pageTitle(displayedPathname)}</h1>
          </div>
          <AccountMenu />
        </header>
        <main
          aria-busy={pendingCatalog}
          className={cn('relative min-h-0 flex-1', workspace ? 'overflow-hidden' : 'overflow-y-auto bg-muted/25')}
        >
          {pendingCatalog ? (
            <div className="absolute inset-0 z-10 overflow-y-auto bg-muted/25" data-pending-route={pendingPathname}>
              <div className="mx-auto max-w-[1500px] space-y-6 px-4 py-7 sm:px-6">
                <div className="space-y-2">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-8 w-64" />
                  <Skeleton className="h-4 w-full max-w-xl" />
                </div>
                <div className="grid min-h-[560px] gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
                  <div className="overflow-hidden rounded-xl border bg-card">
                    <div className="border-b p-4">
                      <Skeleton className="h-9 w-full" />
                    </div>
                    <div className="space-y-3 p-4">
                      {Array.from({ length: 8 }, (_, index) => (
                        <Skeleton className="h-10 w-full" key={index} />
                      ))}
                    </div>
                  </div>
                  <div className="h-80 rounded-xl border bg-card p-5">
                    <Skeleton className="h-5 w-24" />
                    <Skeleton className="mt-5 h-7 w-3/4" />
                    <Skeleton className="mt-3 h-4 w-full" />
                    <Skeleton className="mt-2 h-4 w-2/3" />
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <Outlet key={outletKey} />
          )}
        </main>
      </div>
    </div>
  )
}
