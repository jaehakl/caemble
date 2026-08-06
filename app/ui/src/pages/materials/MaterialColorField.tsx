import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { isMaterialColorValid } from './material-utils'

export function MaterialColorField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const inputId = useId()
  const errorId = `${inputId}-error`
  const valid = isMaterialColorValid(value)
  const trimmed = value.trim()
  const pickerValue = valid && trimmed ? trimmed.toLowerCase() : '#ffffff'

  return (
    <div className="grid gap-1.5">
      <label className="text-sm font-medium" htmlFor={inputId}>
        Color
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Color palette"
          className="h-10 w-14 shrink-0 cursor-pointer rounded-md border border-input bg-background p-1"
          onChange={(event) => onChange(event.target.value.toLowerCase())}
          type="color"
          value={pickerValue}
        />
        <Input
          aria-describedby={!valid ? errorId : undefined}
          aria-invalid={!valid}
          className="min-w-48 flex-1"
          id={inputId}
          onChange={(event) => onChange(event.target.value)}
          pattern="#[0-9A-Fa-f]{6}"
          placeholder="#RRGGBB (선택 사항)"
          value={value}
        />
        <Button disabled={!trimmed} onClick={() => onChange('')} size="sm" type="button" variant="outline">
          색상 지우기
        </Button>
      </div>
      {!valid ? (
        <p className="text-xs text-destructive" id={errorId}>
          Color는 #RRGGBB 형식으로 입력하세요.
        </p>
      ) : !trimmed ? (
        <p className="text-xs text-muted-foreground">선택하지 않으면 색상을 저장하지 않습니다.</p>
      ) : null}
    </div>
  )
}
