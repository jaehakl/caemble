import { LoaderCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function CatalogLoading({ label }: { label: string }) {
  return (
    <div className="flex min-h-60 items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
      <LoaderCircle className="animate-spin" />
      {label}
    </div>
  )
}

export function CatalogError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex min-h-60 flex-col items-center justify-center p-8 text-center">
      <p className="font-medium text-destructive">Catalog API를 사용할 수 없습니다.</p>
      <p className="mt-2 max-w-xl text-sm text-muted-foreground">
        {error instanceof Error ? error.message : String(error)}
      </p>
      {onRetry ? (
        <Button className="mt-4" size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw />
          다시 시도
        </Button>
      ) : null}
    </div>
  )
}
