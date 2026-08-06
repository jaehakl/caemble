import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Boxes, FlaskConical, Gauge, GitBranch, Layers3 } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/features/auth/use-auth'
import { dbTables, getListRequest } from '@/api'
import { catalogCounts } from '@/lib/metadata'

const catalogs = [
  {
    count: catalogCounts.cad,
    description: 'primitive와 operation 문법',
    href: '/catalog/cad',
    icon: Boxes,
    label: 'CAD 요소',
  },
  {
    count: catalogCounts.materials,
    description: 'parameter 258개 · relation 2개',
    href: '/catalog/materials',
    icon: Layers3,
    label: 'Material',
  },
  {
    count: catalogCounts.quantityKinds,
    description: 'domain·tensor order·UCUM unit',
    href: '/catalog/quantity-kinds',
    icon: Gauge,
    label: 'Quantity Kind',
  },
  {
    count: catalogCounts.solvers,
    description: 'parameter·method·result 계약',
    href: '/catalog/solvers',
    icon: FlaskConical,
    label: 'Solver',
  },
] as const

function RecentWork() {
  const { isAuthenticated, user } = useAuth()
  const request = getListRequest('mine')
  const structureQuery = useQuery({
    queryKey: ['work', 'structures'],
    queryFn: () => dbTables.Structure.listRows(request),
    enabled: isAuthenticated,
  })
  const sampleQuery = useQuery({
    queryKey: ['work', 'samples'],
    queryFn: () => dbTables.Sample.listRows(request),
    enabled: isAuthenticated,
  })
  const experimentQuery = useQuery({
    queryKey: ['work', 'experiments'],
    queryFn: () => dbTables.Experiment.listRows(request),
    enabled: isAuthenticated,
  })
  const setupQuery = useQuery({
    queryKey: ['work', 'setups'],
    queryFn: () => dbTables.Setup.listRows(request),
    enabled: isAuthenticated,
  })

  if (!isAuthenticated) {
    return (
      <Card className="border-dashed bg-muted/20">
        <CardContent className="flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base">작업을 저장하려면 로그인하세요</CardTitle>
            <CardDescription className="mt-1">
              공개 Structure·Experiment와 카탈로그는 로그인 없이 열람할 수 있습니다.
            </CardDescription>
          </div>
          <Button asChild variant="outline">
            <Link to="/login">Google로 로그인</Link>
          </Button>
        </CardContent>
      </Card>
    )
  }

  const resources = [
    { label: 'Structure', query: structureQuery },
    { label: 'Sample', query: sampleQuery },
    { label: 'Experiment', query: experimentQuery },
    { label: 'Setup', query: setupQuery },
  ]

  return (
    <section aria-labelledby="recent-work-title">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="font-semibold" id="recent-work-title">
            내 최근 작업
          </h3>
          <p className="text-sm text-muted-foreground">{user?.display_name || user?.email} 계정의 리소스입니다.</p>
        </div>
        <Button asChild size="sm" variant="ghost">
          <Link to="/account">
            전체 보기
            <ArrowRight />
          </Link>
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {resources.map(({ label, query }) => (
          <Card key={label}>
            <CardHeader className="pb-3">
              <CardDescription>{label}</CardDescription>
              {query.isLoading ? (
                <Skeleton className="h-7 w-14" />
              ) : (
                <CardTitle className="text-2xl">{query.data?.total ?? 0}</CardTitle>
              )}
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              {query.isError
                ? '목록을 불러오지 못했습니다.'
                : query.data?.items[0]
                  ? `최근 업데이트 · ${new Date(query.data.items[0].updated_at ?? Date.now()).toLocaleDateString('ko-KR')}`
                  : '아직 저장된 항목이 없습니다.'}
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  )
}

export function HomePage() {
  return (
    <div className="mx-auto max-w-7xl space-y-10 px-4 py-8 sm:px-6 sm:py-12">
      <section className="relative overflow-hidden rounded-2xl border bg-card px-6 py-10 shadow-xs sm:px-10 sm:py-14">
        <div className="pointer-events-none absolute -top-28 -right-24 size-80 rounded-full bg-orange-200/40 blur-3xl" />
        <div className="relative max-w-3xl">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-5xl">
            CAD from Code,
            <br />
            <span className="text-primary">CAE </span> from Data{' '}
          </h2>
          <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground">
            통합
            <br />
            <span className="text-primary">컴퓨터 기반 엔지니어링 </span>프레임워크
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link to="/structures?structure=new&mode=code">
                <GitBranch />
                New Structure
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/docs">
                사용 설명서
                <ArrowRight />
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <section aria-labelledby="catalog-title">
        <div className="mb-4">
          <h3 className="font-semibold" id="catalog-title">
            둘러보기
          </h3>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {catalogs.map(({ count, description, href, icon: Icon, label }) => (
            <Link className="group" key={href} to={href}>
              <Card className="h-full transition-all group-hover:-translate-y-0.5 group-hover:border-orange-300 group-hover:shadow-md">
                <CardHeader>
                  <div className="mb-3 flex size-9 items-center justify-center rounded-lg bg-orange-50 text-orange-700">
                    <Icon className="size-4" />
                  </div>
                  <CardTitle className="flex items-center justify-between">
                    <span>{label}</span>
                    <span className="text-2xl tabular-nums">{count.toLocaleString()}</span>
                  </CardTitle>
                  <CardDescription>{description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      </section>
      <RecentWork />
    </div>
  )
}

export const Component = HomePage
