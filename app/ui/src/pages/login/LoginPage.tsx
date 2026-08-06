import { ArrowLeft, Globe2, ShieldCheck } from 'lucide-react'
import { Link, Navigate, useLocation } from 'react-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/features/auth/use-auth'
import { startGoogleLogin } from '@/api'

export function LoginPage() {
  const { isAuthenticated, isLoading } = useAuth()
  const location = useLocation()
  const from =
    typeof location.state === 'object' && location.state !== null && 'from' in location.state
      ? String(location.state.from)
      : '/account'

  if (isLoading)
    return (
      <div className="mx-auto max-w-md px-4 py-20">
        <Skeleton className="h-72 w-full" />
      </div>
    )
  if (isAuthenticated) return <Navigate replace to={from} />

  return (
    <div className="mx-auto flex min-h-full max-w-md items-center px-4 py-16">
      <Card className="w-full">
        <CardHeader className="text-center">
          <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-xl bg-orange-100 text-orange-700">
            <ShieldCheck />
          </div>
          <CardTitle className="text-xl">Caemble에 로그인</CardTitle>
          <CardDescription>
            Google 계정으로 내 Structure, Sample, Experiment, Setup을 안전하게 저장하세요.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            className="w-full"
            size="lg"
            onClick={() => startGoogleLogin(new URL(from, window.location.origin).href)}
          >
            <Globe2 />
            Google로 계속하기
          </Button>
          <p className="text-center text-xs leading-5 text-muted-foreground">
            인증 토큰은 JavaScript에서 읽을 수 없는 HttpOnly 쿠키로 관리됩니다.
          </p>
          <Button asChild className="w-full" variant="ghost">
            <Link to="/">
              <ArrowLeft />
              홈으로 돌아가기
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

export const Component = LoginPage
