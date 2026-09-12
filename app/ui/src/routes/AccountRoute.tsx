import { AccountWorkspace } from '@/features/account/AccountPage'

export function AccountPage() {
  return (
    <main className="h-full overflow-auto bg-background text-foreground">
      <AccountWorkspace />
    </main>
  )
}

export const Component = AccountPage
