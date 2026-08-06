import { CalendarDays, Link2, LoaderCircle, Mail, ShieldCheck, Unplug } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Navigate, useLocation } from 'react-router'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/PageHeader'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth, useDeleteGpStationConnection, useSaveGpStationConnection } from '@/features/auth/use-auth'
import { validateGpStationConnection } from '@/features/cae/connection'

export function AccountPage() {
  const auth = useAuth()
  const location = useLocation()
  const saveConnection = useSaveGpStationConnection()
  const deleteConnection = useDeleteGpStationConnection()
  const connection = auth.user?.gpstation_connection ?? null
  const [apiBaseUrl, setApiBaseUrl] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [connectionWarning, setConnectionWarning] = useState<string | null>(null)

  useEffect(() => {
    setApiBaseUrl(connection?.api_base_url ?? '')
  }, [connection?.api_base_url])

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
            Server URL과 Access Token은 계정에 저장되며 로그인할 때 자동으로 CAE 실행에 연결됩니다.
          </p>
        </CardHeader>
        <CardContent className="space-y-4 border-t pt-6">
          {connection ? (
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm text-emerald-700">GPStation 연결 정보가 저장되어 있습니다.</p>
                <p className="mt-1 text-xs text-muted-foreground">Server · {connection.api_base_url}</p>
              </div>
              <Button
                disabled={saveConnection.isPending || deleteConnection.isPending}
                onClick={() => {
                  setConnectionError(null)
                  setConnectionWarning(null)
                  void deleteConnection
                    .mutateAsync()
                    .then(() => {
                      setApiBaseUrl('')
                      setTokenInput('')
                    })
                    .catch((error: unknown) =>
                      setConnectionError(
                        error instanceof Error ? error.message : 'GPStation 연결을 해제하지 못했습니다.',
                      ),
                    )
                }}
                type="button"
                variant="outline"
              >
                {deleteConnection.isPending ? <LoaderCircle className="animate-spin" /> : <Unplug />}
                연결 해제
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">저장된 GPStation 연결 정보가 없습니다.</p>
          )}
          <form
            className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
            onSubmit={(event) => {
              event.preventDefault()
              setConnectionError(null)
              setConnectionWarning(null)
              const nextConnection = {
                api_base_url: apiBaseUrl,
                access_token: tokenInput,
              }
              void validateGpStationConnection(nextConnection)
                .then(async ({ hasOnlineCaeLauncher }) => {
                  await saveConnection.mutateAsync(nextConnection)
                  setTokenInput('')
                  if (!hasOnlineCaeLauncher) {
                    setConnectionWarning('Token은 확인되어 저장했지만 현재 온라인 상태인 cae launcher가 없습니다.')
                  }
                })
                .catch((error: unknown) =>
                  setConnectionError(error instanceof Error ? error.message : 'GPStation 연결에 실패했습니다.'),
                )
            }}
          >
            <Input
              aria-label="GPStation API URL"
              autoComplete="url"
              onChange={(event) => setApiBaseUrl(event.target.value)}
              placeholder="http://localhost:8000"
              type="url"
              value={apiBaseUrl}
            />
            <Input
              aria-label="GPStation Access Token"
              autoComplete="off"
              onChange={(event) => setTokenInput(event.target.value)}
              placeholder={connection ? '새 Token을 입력해 연결 교체' : 'gpsk_...'}
              type="password"
              value={tokenInput}
            />
            <Button
              disabled={
                !apiBaseUrl.trim() || !tokenInput.trim() || saveConnection.isPending || deleteConnection.isPending
              }
              type="submit"
            >
              {saveConnection.isPending ? <LoaderCircle className="animate-spin" /> : null}
              {connection ? '연결 교체' : '연결 저장'}
            </Button>
          </form>
          {connectionWarning ? <p className="text-sm text-amber-700">{connectionWarning}</p> : null}
          {connectionError ? <p className="text-sm text-destructive">{connectionError}</p> : null}
        </CardContent>
      </Card>
    </div>
  )
}

export const Component = AccountPage
