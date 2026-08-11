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
})

export type DefinitionFormValues = z.infer<typeof definitionFormSchema>

export function SaveDefinitionDialog({
  defaults,
  description,
  context,
  kind,
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
  kind: 'Experiment' | 'Structure'
  onOpenChange: (open: boolean) => void
  onSubmit: (values: DefinitionFormValues) => Promise<void>
  open: boolean
  pending: boolean
  submitLabel?: string
  title?: string
}) {
  const form = useForm<DefinitionFormValues>({ resolver: zodResolver(definitionFormSchema), defaultValues: defaults })
  const defaultDescription = defaults.description
  const defaultName = defaults.name
  useEffect(() => {
    if (open) form.reset({ description: defaultDescription, name: defaultName })
  }, [defaultDescription, defaultName, form, open])

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (nextOpen || !pending) onOpenChange(nextOpen)
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title ?? `${kind} 정의 저장`}</DialogTitle>
          <DialogDescription>
            {description ?? '이름, 설명과 현재 Source code를 저장합니다. 평가된 vars는 별도 실현값으로 저장하세요.'}
          </DialogDescription>
        </DialogHeader>
        {context}
        <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
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
