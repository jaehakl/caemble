import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CalendarDays,
  Clipboard,
  Globe2,
  KeyRound,
  LoaderCircle,
  LogOut,
  Mail,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { useState } from 'react'
import { dbTables, startGoogleLogin, type AccessKeyScope } from '@/api'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/PageHeader'
import { useAuth, useLogout } from '@/features/auth/use-auth'
import { formatRuntimeDate, runtimeErrorMessage } from '@/features/runtime/format'

export function AccountWorkspace() {
  const auth = useAuth()
  const logout = useLogout()
  const queryClient = useQueryClient()
  const [tokenName, setTokenName] = useState('')
  const [tokenScope, setTokenScope] = useState<AccessKeyScope>('client')
  const [expiresAt, setExpiresAt] = useState('')
  const [createdSecret, setCreatedSecret] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const tokens = useQuery({
    queryKey: ['runtime', 'access-keys'],
    queryFn: () => dbTables.AccessKey.list(),
    enabled: auth.isAuthenticated,
  })
  const createToken = useMutation({
    mutationFn: () =>
      dbTables.AccessKey.create({
        name: tokenName,
        scopes: [tokenScope],
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
      }),
    onSuccess: async (result) => {
      setCreatedSecret(result.secret)
      setTokenName('')
      setExpiresAt('')
      setError(null)
      setMessage('Access Token을 생성했습니다. 원문은 지금만 확인할 수 있습니다.')
      await queryClient.invalidateQueries({ queryKey: ['runtime', 'access-keys'] })
    },
    onError: (nextError) => setError(runtimeErrorMessage(nextError, 'Access Token을 생성하지 못했습니다.')),
  })
  const revokeToken = useMutation({
    mutationFn: (id: string) => dbTables.AccessKey.revoke(id),
    onSuccess: async () => {
      setCreatedSecret(null)
      setError(null)
      setMessage('Access Token을 폐기했습니다.')
      await queryClient.invalidateQueries({ queryKey: ['runtime', 'access-keys'] })
    },
    onError: (nextError) => setError(runtimeErrorMessage(nextError, 'Access Token을 폐기하지 못했습니다.')),
  })

  if (auth.isLoading)
    return (
      <div className="mx-auto max-w-6xl space-y-6 px-5 py-10">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    )
  if (!auth.isAuthenticated || !auth.user)
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-md items-center px-4 py-10">
        <Card className="w-full">
          <CardHeader className="text-center">
            <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-xl bg-orange-100 text-orange-700">
              <ShieldCheck />
            </div>
            <CardTitle className="text-xl">Caemble에 로그인</CardTitle>
            <p className="mt-2 text-sm text-muted-foreground">
              Google 계정으로 CAE 연구 데이터와 Runtime 기능을 안전하게 관리하세요.
            </p>
          </CardHeader>
          <CardContent>
            <Button className="w-full" size="lg" onClick={() => startGoogleLogin(window.location.href)}>
              <Globe2 />
              Google로 계속하기
            </Button>
            <p className="mt-4 text-center text-xs leading-5 text-muted-foreground">
              로그인 후 현재 CAE Workbench로 돌아옵니다.
            </p>
          </CardContent>
        </Card>
      </div>
    )

  const label = auth.user.display_name || auth.user.email || '사용자'
  return (
    <div className="mx-auto max-w-6xl space-y-8 px-5 py-10">
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          description="Google OAuth 계정과 Caemble API 및 Launcher 접근 권한을 관리합니다."
          eyebrow="Account"
          title="내 계정"
        />
        <Button disabled={logout.isPending} type="button" variant="outline" onClick={() => logout.mutate()}>
          {logout.isPending ? <LoaderCircle className="animate-spin" /> : <LogOut />}
          로그아웃
        </Button>
      </div>
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
          <AccountField icon={Mail} label="이메일" value={auth.user.email || '연결되지 않음'} />
          <AccountField icon={ShieldCheck} label="역할" value={auth.user.roles.join(', ') || 'user'} />
          <AccountField
            icon={CalendarDays}
            label="가입일"
            value={auth.user.created_at ? new Date(auth.user.created_at).toLocaleDateString('ko-KR') : '정보 없음'}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <KeyRound className="size-5 text-primary" />
              Access Token
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              외부 SDK에는 client token을, Launcher 등록에는 launcher token을 사용하세요.
            </p>
          </div>
          <Button disabled={tokens.isFetching} onClick={() => void tokens.refetch()} size="sm" variant="outline">
            <RefreshCw className={tokens.isFetching ? 'animate-spin' : undefined} />
            새로고침
          </Button>
        </CardHeader>
        <CardContent className="space-y-6 border-t pt-6">
          <form
            className="grid gap-3 rounded-lg border bg-muted/20 p-4 md:grid-cols-[minmax(0,1fr)_10rem_13rem_auto]"
            onSubmit={(event) => {
              event.preventDefault()
              setError(null)
              setMessage(null)
              setCreatedSecret(null)
              createToken.mutate()
            }}
          >
            <Input
              aria-label="Token 이름"
              onChange={(event) => setTokenName(event.target.value)}
              placeholder="예: local-launcher"
              value={tokenName}
            />
            <select
              aria-label="Token 용도"
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              onChange={(event) => setTokenScope(event.target.value as AccessKeyScope)}
              value={tokenScope}
            >
              <option value="client">client</option>
              <option value="launcher">launcher</option>
            </select>
            <Input
              aria-label="Token 만료일"
              onChange={(event) => setExpiresAt(event.target.value)}
              type="datetime-local"
              value={expiresAt}
            />
            <Button disabled={!tokenName.trim() || createToken.isPending} type="submit">
              {createToken.isPending ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
              생성
            </Button>
          </form>

          {createdSecret ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950">
              <p className="text-sm font-semibold">새 Access Token · 다시 표시되지 않습니다.</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <code className="min-w-0 flex-1 overflow-x-auto rounded bg-white px-3 py-2 text-xs">
                  {createdSecret}
                </code>
                <Button
                  onClick={() => {
                    void navigator.clipboard.writeText(createdSecret).then(() => setMessage('Token을 복사했습니다.'))
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Clipboard />
                  복사
                </Button>
              </div>
            </div>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {message ? <p className="text-sm text-emerald-700">{message}</p> : null}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>이름</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>용도</TableHead>
                <TableHead>상태</TableHead>
                <TableHead>마지막 사용</TableHead>
                <TableHead>만료</TableHead>
                <TableHead className="text-right">작업</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.isLoading ? (
                <EmptyTokenRow text="Access Token을 불러오는 중입니다." />
              ) : tokens.isError ? (
                <EmptyTokenRow text={runtimeErrorMessage(tokens.error, 'Access Token을 불러오지 못했습니다.')} />
              ) : tokens.data?.items.length ? (
                tokens.data.items.map((token) => (
                  <TableRow key={token.id}>
                    <TableCell className="font-medium">{token.name}</TableCell>
                    <TableCell className="font-mono text-xs">{token.key_prefix}</TableCell>
                    <TableCell>{token.scopes.join(', ')}</TableCell>
                    <TableCell>
                      <Badge className={token.status === 'active' ? 'bg-primary text-primary-foreground' : undefined}>
                        {token.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatRuntimeDate(token.last_used_at)}</TableCell>
                    <TableCell>{formatRuntimeDate(token.expires_at)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        disabled={token.status !== 'active' || revokeToken.isPending}
                        onClick={() => {
                          if (window.confirm(`${token.name} token을 폐기할까요?`)) revokeToken.mutate(token.id)
                        }}
                        size="sm"
                        type="button"
                        variant="destructive"
                      >
                        <Trash2 />
                        폐기
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <EmptyTokenRow text="생성된 Access Token이 없습니다." />
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

function AccountField({ icon: Icon, label, value }: { icon: typeof Mail; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 size-4 text-primary" />
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-sm">{value}</p>
      </div>
    </div>
  )
}

function EmptyTokenRow({ text }: { text: string }) {
  return (
    <TableRow>
      <TableCell className="py-8 text-center text-muted-foreground" colSpan={7}>
        {text}
      </TableCell>
    </TableRow>
  )
}
