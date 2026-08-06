import { CalendarDays, Mail, ShieldCheck } from 'lucide-react'
import { Navigate, useLocation } from 'react-router'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/PageHeader'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/features/auth/use-auth'

export function AccountPage() {
  const auth = useAuth()
  const location = useLocation()
  if (auth.isLoading)
    return (
      <div className="mx-auto max-w-5xl space-y-6 px-5 py-10">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    )
  if (!auth.isAuthenticated || !auth.user)
    return <Navigate replace state={{ from: `${location.pathname}${location.search}` }} to="/login" />

  const label = auth.user.display_name || auth.user.email || '사용자'
  return (
    <div className="mx-auto max-w-5xl space-y-8 px-5 py-10">
      <PageHeader
        description="Google OAuth로 연결된 계정과 Caemble 권한을 확인합니다."
        eyebrow="Account"
        title="내 계정"
      />
      <Card>
        <CardHeader className="flex flex-row items-center gap-4">
          <Avatar className="size-16">
            <AvatarImage alt="" src={auth.user.picture_url ?? undefined} />
            <AvatarFallback className="text-xl">{label.slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div>
            <CardTitle className="text-xl">{label}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">사용자 ID · {auth.user.id}</p>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 border-t pt-6 sm:grid-cols-3">
          <div className="flex items-start gap-3">
            <Mail className="mt-0.5 size-4 text-primary" />
            <div>
              <p className="text-xs text-muted-foreground">이메일</p>
              <p className="mt-1 text-sm">{auth.user.email || '연결되지 않음'}</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 size-4 text-primary" />
            <div>
              <p className="text-xs text-muted-foreground">역할</p>
              <p className="mt-1 text-sm">{auth.user.roles.join(', ') || 'user'}</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <CalendarDays className="mt-0.5 size-4 text-primary" />
            <div>
              <p className="text-xs text-muted-foreground">가입일</p>
              <p className="mt-1 text-sm">
                {auth.user.created_at ? new Date(auth.user.created_at).toLocaleDateString('ko-KR') : '정보 없음'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export const Component = AccountPage
