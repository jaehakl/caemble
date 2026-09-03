import { AlertTriangle, RotateCcw } from 'lucide-react'
import { isRouteErrorResponse, useRouteError } from 'react-router'
import { Button } from '@/components/ui/button'

export function RouteErrorPage() {
  const error = useRouteError()
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : '알 수 없는 오류가 발생했습니다.'
  return (
    <div className="flex min-h-full items-center justify-center px-5 py-16 text-center">
      <div className="max-w-lg">
        <AlertTriangle className="mx-auto size-12 text-destructive" />
        <h2 className="mt-5 text-2xl font-semibold">페이지를 표시하지 못했습니다</h2>
        <p className="mt-3 text-sm text-muted-foreground">{message}</p>
        <Button className="mt-6" onClick={() => window.location.reload()}>
          <RotateCcw />
          다시 시도
        </Button>
      </div>
    </div>
  )
}
