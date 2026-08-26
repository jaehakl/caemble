import { useEffect, useId, type ReactNode } from 'react'
import { useForm } from 'react-hook-form'
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

export type DefinitionFormValues = Readonly<{
  namespace: string
  name: string
  description: string
  repository: string
  key: string
  bump: 'patch' | 'minor' | 'major'
}>
export type ExperimentSaveMode = 'create' | 'overwrite' | 'new_version'

export function SaveDefinitionDialog({
  defaults,
  description,
  context,
  mode,
  namespaceOptions = [],
  onOpenChange,
  onSubmit,
  open,
  pending,
  submitLabel = '정의 저장',
  title,
}: {
  defaults: DefinitionFormValues
  description?: string
  context?: ReactNode
  mode: ExperimentSaveMode
  namespaceOptions?: readonly string[]
  onOpenChange: (open: boolean) => void
  onSubmit: (values: DefinitionFormValues) => Promise<void>
  open: boolean
  pending: boolean
  submitLabel?: string
  title?: string
}) {
  const namespaceListId = useId()
  const form = useForm<DefinitionFormValues>({ defaultValues: defaults })
  const defaultBump = defaults.bump
  const defaultDescription = defaults.description
  const defaultKey = defaults.key
  const defaultName = defaults.name
  const defaultNamespace = defaults.namespace
  const defaultRepository = defaults.repository
  useEffect(() => {
    if (open) {
      form.reset({
        bump: defaultBump,
        description: defaultDescription,
        key: defaultKey,
        name: defaultName,
        namespace: defaultNamespace,
        repository: defaultRepository,
      })
    }
  }, [defaultBump, defaultDescription, defaultKey, defaultName, defaultNamespace, defaultRepository, form, open])

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (nextOpen || !pending) onOpenChange(nextOpen)
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title ?? 'Experiment 저장'}</DialogTitle>
          <DialogDescription className="sr-only">
            {description ?? '이름, 설명과 현재 Source code를 저장합니다. 평가된 vars는 별도 실현값으로 저장하세요.'}
          </DialogDescription>
        </DialogHeader>
        {context}
        <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="grid gap-1.5 text-sm font-medium">
              Namespace
              <Input autoFocus disabled={pending} list={namespaceListId} {...form.register('namespace')} />
              <datalist id={namespaceListId}>
                {namespaceOptions.map((namespace) => (
                  <option key={namespace} value={namespace} />
                ))}
              </datalist>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Repository
              <Input disabled={pending} {...form.register('repository')} />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Experiment key
              <Input disabled={pending} {...form.register('key')} />
            </label>
          </div>
          {mode === 'create' ? null : (
            <p className="text-xs text-muted-foreground">
              Namespace, Repository 또는 Experiment key 변경은 모든 Version에 적용됩니다.
            </p>
          )}
          {mode === 'new_version' ? (
            <label className="grid gap-1.5 text-sm font-medium">
              Version 증가
              <select
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                disabled={pending}
                {...form.register('bump')}
              >
                <option value="patch">Patch</option>
                <option value="minor">Minor</option>
                <option value="major">Major</option>
              </select>
            </label>
          ) : null}
          <label className="grid gap-1.5 text-sm font-medium">
            이름
            <Input disabled={pending} {...form.register('name')} />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            설명
            <textarea
              className="min-h-24 rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
              disabled={pending}
              {...form.register('description')}
            />
          </label>
          <DialogFooter>
            <Button disabled={pending} type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button disabled={pending} type="submit">
              {pending ? '저장 중…' : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
