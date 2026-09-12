import { useNavigate } from 'react-router'
import { WorkbenchSignInPrompt } from '@/features/auth/WorkbenchSignInPrompt'
import { useAuth } from '@/features/auth/use-auth'
import { CaeBatchPanel } from '@/features/cae/CaeBatchPanel'
import { JobsWorkspace } from '@/features/jobs/JobsPage'
import { LaunchersWorkspace } from '@/features/launchers/LaunchersPage'

export function SettingsPage() {
  const auth = useAuth()
  const navigate = useNavigate()

  if (auth.isPending)
    return (
      <main className="grid h-full place-items-center" role="status">
        로그인 상태를 확인하는 중…
      </main>
    )
  if (!auth.isAuthenticated)
    return (
      <main className="h-full overflow-auto">
        <WorkbenchSignInPrompt
          description="Launcher와 Job 상태를 확인하려면 Account에서 로그인하세요."
          onSignIn={() => navigate('/account?returnTo=%2Fsettings')}
        />
      </main>
    )

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-muted/20 text-foreground">
      <header className="flex h-12 shrink-0 items-center border-b bg-background px-4">
        <h1 className="font-semibold">Setting</h1>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto p-3 xl:grid-cols-3 xl:overflow-hidden">
        <section className="min-h-[32rem] overflow-hidden rounded-lg border bg-background xl:min-h-0">
          <LaunchersWorkspace className="h-full" compact />
        </section>
        <section className="min-h-[32rem] overflow-hidden rounded-lg border bg-background xl:min-h-0">
          <JobsWorkspace className="h-full" compact />
        </section>
        <section className="min-h-[32rem] overflow-hidden rounded-lg border bg-background xl:min-h-0">
          <CaeBatchPanel className="h-full" compact />
        </section>
      </div>
    </main>
  )
}

export const Component = SettingsPage
