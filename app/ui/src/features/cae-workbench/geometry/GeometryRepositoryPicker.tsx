import { Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import type { GeometryRepositoryRecord } from '@/api'
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

type GeometryRepositoryPickerProps = {
  disabled?: boolean
  namespace: string | null
  onChange: (repository: GeometryRepositoryRecord) => void
  onCreate: (name: string, description: string) => Promise<GeometryRepositoryRecord>
  repositories: readonly GeometryRepositoryRecord[]
  value: number | null
}

export function GeometryRepositoryPicker({
  disabled,
  namespace,
  onChange,
  onCreate,
  repositories,
  value,
}: GeometryRepositoryPickerProps) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const active = repositories.filter((repository) => repository.archived_at === null)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '').trim()
    const description = String(form.get('description') ?? '').trim()
    setCreating(true)
    void onCreate(name, description)
      .then((repository) => {
        onChange(repository)
        setOpen(false)
        toast.success('Repository를 만들었습니다. 새 Repository가 자동 선택됩니다.')
      })
      .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setCreating(false))
  }

  return (
    <>
      <div className="flex gap-2">
        <select
          aria-label="Repository"
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
          disabled={disabled}
          onChange={(event) => {
            const repository = active.find((item) => item.id === Number(event.target.value))
            if (repository) onChange(repository)
          }}
          required
          value={value ?? ''}
        >
          <option disabled value="">
            Repository 선택
          </option>
          {active.map((repository) => (
            <option key={repository.id} value={repository.id}>
              {repository.namespace}/{repository.slug}
            </option>
          ))}
        </select>
        <Button disabled={disabled || !namespace} onClick={() => setOpen(true)} type="button" variant="outline">
          <Plus /> 새 Repository
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <form className="grid gap-4" onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>새 Repository</DialogTitle>
              <DialogDescription>
                {namespace ?? 'Geometry namespace를 먼저 설정하세요.'} namespace에 Repository를 만듭니다.
              </DialogDescription>
            </DialogHeader>
            <label className="grid gap-1 text-sm">
              Repository 이름
              <Input
                maxLength={64}
                minLength={1}
                name="name"
                pattern="[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?"
                placeholder="common"
                required
              />
              <span className="text-xs text-muted-foreground">영문 소문자, 숫자, 하이픈을 사용하세요.</span>
            </label>
            <label className="grid gap-1 text-sm">
              설명
              <Input maxLength={2_000} name="description" />
            </label>
            <DialogFooter>
              <Button onClick={() => setOpen(false)} type="button" variant="outline">
                취소
              </Button>
              <Button disabled={creating} type="submit">
                만들기
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
