import { useNavigate } from 'react-router'
import { AdminWorkspace } from '@/features/cae-workbench/AdminWorkspace'
import { useAuth } from '@/features/auth/use-auth'
import { NotFoundView } from '@/features/error/NotFoundView'

export function AdminPage() {
  const auth = useAuth()
  const navigate = useNavigate()

  if (auth.isPending)
    return (
      <main className="grid h-full place-items-center" role="status">
        로그인 상태를 확인하는 중…
      </main>
    )
  if (!auth.user?.roles.includes('admin')) return <NotFoundView />

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center border-b px-4">
        <h1 className="font-semibold">Admin</h1>
      </header>
      <div className="min-h-0 flex-1">
        <AdminWorkspace
          currentUser={auth.user}
          onOpenExperiment={(experiment) => navigate(`/workbench?experiment=${experiment.id}`)}
        />
      </div>
    </main>
  )
}

export const Component = AdminPage
