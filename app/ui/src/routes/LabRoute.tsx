import { useRef, useState } from 'react'
import { Plus, Square, Trash2 } from 'lucide-react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { AiChatWorkspace, type AiChatCommand } from '@/features/ai/AiChatPage'
import { useAuth } from '@/features/auth/use-auth'

export function LabPage() {
  const auth = useAuth()
  const navigate = useNavigate()
  const sequence = useRef(0)
  const [command, setCommand] = useState<AiChatCommand | null>(null)
  const request = (type: AiChatCommand['type']) => setCommand({ id: ++sequence.current, type })

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
        <h1 className="font-semibold">Lab</h1>
        <div className="flex items-center gap-2">
          <Button disabled={!auth.isAuthenticated} onClick={() => request('new')} size="sm" variant="outline">
            <Plus />
            New Chat
          </Button>
          <Button disabled={!auth.isAuthenticated} onClick={() => request('end')} size="sm" variant="outline">
            <Square />
            End
          </Button>
          <Button disabled={!auth.isAuthenticated} onClick={() => request('cancel')} size="sm" variant="outline">
            <Trash2 />
            Cancel
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <AiChatWorkspace command={command} onRequestLogin={() => navigate('/account?returnTo=%2Flab')} />
      </div>
    </main>
  )
}

export const Component = LabPage
