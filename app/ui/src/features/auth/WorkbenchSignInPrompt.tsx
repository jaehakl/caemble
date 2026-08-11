import { ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function WorkbenchSignInPrompt({ description, onSignIn }: { description: string; onSignIn: () => void }) {
  return (
    <div className="flex min-h-80 items-center justify-center p-8 text-center">
      <div className="max-w-md">
        <ShieldCheck className="mx-auto size-10 text-primary" />
        <h2 className="mt-4 text-xl font-semibold">로그인이 필요합니다</h2>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <Button className="mt-5" type="button" onClick={onSignIn}>
          Account 열기
        </Button>
      </div>
    </div>
  )
}
