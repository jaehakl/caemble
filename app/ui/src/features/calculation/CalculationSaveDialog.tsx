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

export type CalculationSaveValues = Readonly<{
  description: string
  name: string
}>

export function CalculationSaveDialog({
  defaults,
  isNew,
  onOpenChange,
  onSubmit,
  open,
  pending,
}: {
  defaults: CalculationSaveValues
  isNew: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (values: CalculationSaveValues) => Promise<void>
  open: boolean
  pending: boolean
}) {
  const [name, setName] = useState(defaults.name)
  const [description, setDescription] = useState(defaults.description)

  useEffect(() => {
    if (!open) return
    setName(defaults.name)
    setDescription(defaults.description)
  }, [defaults.description, defaults.name, open])

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!name.trim() || pending) return
    void onSubmit({ description, name })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen || !pending) onOpenChange(nextOpen)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isNew ? '새 Calculation 저장' : 'Calculation 저장'}</DialogTitle>
          <DialogDescription>
            이름, 설명과 현재 Source code를 저장합니다. Calculation Output은 저장되지 않습니다.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <label className="grid gap-1.5 text-sm font-medium">
            이름
            <Input
              autoFocus
              disabled={pending}
              maxLength={255}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            설명
            <textarea
              className="min-h-24 rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
              disabled={pending}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <DialogFooter>
            <Button disabled={pending} type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button disabled={pending || !name.trim()} type="submit">
              {pending ? '저장 중…' : '저장'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
