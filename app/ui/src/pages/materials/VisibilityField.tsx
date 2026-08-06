import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export type Visibility = 'public' | 'private'

export function VisibilityField({
  disabled,
  onChange,
  value,
}: {
  disabled?: boolean
  onChange: (value: Visibility) => void
  value: Visibility
}) {
  return (
    <label className="grid gap-1.5 text-sm font-medium">
      공개 범위
      <Select disabled={disabled} onValueChange={(next) => onChange(next as Visibility)} value={value}>
        <SelectTrigger aria-label="공개 범위">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="public">Public</SelectItem>
          <SelectItem value="private">Private</SelectItem>
        </SelectContent>
      </Select>
    </label>
  )
}
