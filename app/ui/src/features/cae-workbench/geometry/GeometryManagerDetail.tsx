import { ChevronLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function GeometryManagerDetail({
  mobileOpen,
  onBack,
  outsideFilter = false,
  children,
}: {
  mobileOpen: boolean
  onBack: () => void
  outsideFilter?: boolean
  children: ReactNode
}) {
  return (
    <main className={cn('min-h-0 overflow-auto p-3 lg:block lg:p-5', !mobileOpen && 'hidden')}>
      <div className="mb-3 flex items-center gap-2 lg:hidden">
        <Button onClick={onBack} size="sm" variant="outline">
          <ChevronLeft /> 목록
        </Button>
        <span className="truncate text-sm font-medium">상세 보기</span>
      </div>
      {outsideFilter ? (
        <div
          className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950"
          role="status"
        >
          현재 목록 필터 밖의 선택 항목입니다. 필터는 유지한 채 상세를 표시합니다.
        </div>
      ) : null}
      {children}
    </main>
  )
}
