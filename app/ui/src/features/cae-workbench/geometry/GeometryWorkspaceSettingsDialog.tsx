import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

export function GeometryWorkspaceSettingsDialog({
  open,
  namespace,
  pending,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  namespace: string | null
  pending: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (namespace: string) => void
}) {
  const [value, setValue] = useState(namespace ?? '')
  useEffect(() => setValue(namespace ?? ''), [namespace, open])
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSubmit(value.trim())
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Workspace 설정</DialogTitle>
            <DialogDescription>
              새 Geometry Repository에 사용할 기본 namespace를 설정합니다. 기존 좌표와 Published Version은 변경되지
              않습니다.
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-1 text-sm">
            기본 Geometry namespace
            <Input
              autoFocus
              maxLength={32}
              minLength={3}
              onChange={(event) => setValue(event.target.value)}
              pattern="[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?"
              required
              value={value}
            />
          </label>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
              취소
            </Button>
            <Button disabled={pending} type="submit">
              변경
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
