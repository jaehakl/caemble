import { CalendarDays, Link2, LoaderCircle, Mail, ShieldCheck, Unplug } from 'lucide-react'
import { useState } from 'react'
import { Navigate, useLocation } from 'react-router'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/PageHeader'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/features/auth/use-auth'
import {
  clearCaeAccessToken,
  connectCaeAccessToken,
  gpStationApiBaseUrl,
  useCaeAccessToken,
} from '@/features/cae/connection'

export function AccountPage() {
  const auth = useAuth()
  const location = useLocation()
  const accessToken = useCaeAccessToken()
  const [tokenInput, setTokenInput] = useState('')
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
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
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Link2 className="size-5 text-primary" />
            GPStation CAE 연결
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Access Token은 이 브라우저 탭의 React memory에만 보관되며 reload 또는 연결 해제 시 사라집니다.
          </p>
        </CardHeader>
        <CardContent className="space-y-4 border-t pt-6">
          <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Server · </span>
            {gpStationApiBaseUrl()}
          </div>
          {accessToken ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-emerald-700">CAE Access Token이 연결되어 있습니다.</p>
              <Button onClick={clearCaeAccessToken} type="button" variant="outline">
                <Unplug />
                연결 해제
              </Button>
            </div>
          ) : (
            <form
              className="flex flex-col gap-3 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault()
                setConnecting(true)
                setConnectionError(null)
                void connectCaeAccessToken(tokenInput)
                  .then(() => setTokenInput(''))
                  .catch((error: unknown) =>
                    setConnectionError(error instanceof Error ? error.message : 'GPStation 연결에 실패했습니다.'),
                  )
                  .finally(() => setConnecting(false))
              }}
            >
              <Input
                aria-label="GPStation Access Token"
                autoComplete="off"
                onChange={(event) => setTokenInput(event.target.value)}
                placeholder="gpsk_..."
                type="password"
                value={tokenInput}
              />
              <Button disabled={!tokenInput.trim() || connecting} type="submit">
                {connecting ? <LoaderCircle className="animate-spin" /> : null}
                연결
              </Button>
            </form>
          )}
          {connectionError ? <p className="text-sm text-destructive">{connectionError}</p> : null}
        </CardContent>
      </Card>
    </div>
  )
}

export const Component = AccountPage
