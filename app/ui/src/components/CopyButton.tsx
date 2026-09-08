import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from './ui/button'

export function CopyButton({ text, label = '코드 복사' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
      variant="outline"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
        } catch {
          toast.error('복사하지 못했습니다. 내용을 선택해 복사해 주세요.')
        }
      }}
      onBlur={() => setCopied(false)}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? '복사됨' : label}
    </Button>
  )
}
