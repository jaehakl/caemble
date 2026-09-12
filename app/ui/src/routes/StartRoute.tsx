import { Navigate, useLocation } from 'react-router'
import { useAuth } from '@/features/auth/use-auth'

export function Component() {
  const auth = useAuth()
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  if (params.has('experiment') || params.has('help')) {
    return <Navigate replace to={{ pathname: '/workbench', search: location.search, hash: location.hash }} />
  }
  if (auth.isPending)
    return (
      <div role="status" className="grid h-dvh place-items-center">
        로그인 상태를 확인하는 중…
      </div>
    )
  return <Navigate replace to={auth.isAuthenticated ? '/workbench' : '/showcase'} />
}
