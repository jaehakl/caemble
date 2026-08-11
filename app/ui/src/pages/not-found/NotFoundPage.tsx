import { ArrowLeft, SearchX } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'

export function NotFoundPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-5 py-16 text-center text-foreground">
      <div>
        <SearchX className="mx-auto size-12 text-primary" />
        <p className="mt-5 text-xs font-semibold tracking-[0.2em] text-primary uppercase">404</p>
        <h2 className="mt-2 text-3xl font-semibold">페이지를 찾을 수 없습니다</h2>
        <p className="mt-3 text-muted-foreground">주소를 확인하거나 CAE Workbench에서 다시 시작해 주세요.</p>
        <Button asChild className="mt-6">
          <Link to="/">
            <ArrowLeft />
            CAE Workbench로
          </Link>
        </Button>
      </div>
    </div>
  )
}

export const Component = NotFoundPage
