import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, type ReactNode } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
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

const definitionFormSchema = z.object({
  name: z.string().trim().min(1, '이름을 입력하세요.').max(200, '이름은 200자 이하여야 합니다.'),
  description: z.string().trim().max(2_000, '설명은 2,000자 이하여야 합니다.'),
  repository: z
    .string()
    .trim()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, '소문자, 숫자, -로 Repository를 입력하세요.'),
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, '소문자, 숫자, -로 Experiment key를 입력하세요.'),
  bump: z.enum(['patch', 'minor', 'major']),
})

export type DefinitionFormValues = z.infer<typeof definitionFormSchema>
export type ExperimentSaveMode = 'create' | 'overwrite' | 'new_version'

export function SaveDefinitionDialog({
  defaults,
  description,
  context,
  mode,
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
  onOpenChange: (open: boolean) => void
  onSubmit: (values: DefinitionFormValues) => Promise<void>
  open: boolean
  pending: boolean
  submitLabel?: string
  title?: string
}) {
  const form = useForm<DefinitionFormValues>({ resolver: zodResolver(definitionFormSchema), defaultValues: defaults })
  const defaultBump = defaults.bump
  const defaultDescription = defaults.description
  const defaultKey = defaults.key
  const defaultName = defaults.name
  const defaultRepository = defaults.repository
  useEffect(() => {
    if (open) {
      form.reset({
        bump: defaultBump,
        description: defaultDescription,
        key: defaultKey,
        name: defaultName,
        repository: defaultRepository,
      })
    }
  }, [defaultBump, defaultDescription, defaultKey, defaultName, defaultRepository, form, open])

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
          <DialogDescription>
            {description ?? '이름, 설명과 현재 Source code를 저장합니다. 평가된 vars는 별도 실현값으로 저장하세요.'}
          </DialogDescription>
        </DialogHeader>
        {context}
        <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
          {mode === 'create' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm font-medium">
                Repository
                <Input disabled={pending} {...form.register('repository')} />
                {form.formState.errors.repository ? (
                  <span className="text-xs text-destructive">{form.formState.errors.repository.message}</span>
                ) : null}
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                Experiment key
                <Input disabled={pending} {...form.register('key')} />
                {form.formState.errors.key ? (
                  <span className="text-xs text-destructive">{form.formState.errors.key.message}</span>
                ) : null}
              </label>
            </div>
          ) : null}
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
            <Input autoFocus disabled={pending} {...form.register('name')} />
            {form.formState.errors.name ? (
              <span className="text-xs text-destructive">{form.formState.errors.name.message}</span>
            ) : null}
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            설명
            <textarea
              className="min-h-24 rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
              disabled={pending}
              {...form.register('description')}
            />
            {form.formState.errors.description ? (
              <span className="text-xs text-destructive">{form.formState.errors.description.message}</span>
            ) : null}
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
