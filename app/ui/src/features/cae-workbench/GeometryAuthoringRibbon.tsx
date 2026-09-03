import { Braces, ChevronDown, Shapes } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { CadEditorAuthoringState } from '@/features/viewer/editor/CadEditor'
import { operationAuthoringElements, primitiveAuthoringElements } from '@/lib/cad/source'

export function GeometryAuthoringRibbon({ state }: { state: CadEditorAuthoringState | null }) {
  const unavailableReason = state ? undefined : '현재 Editor에서는 Geometry source를 편집할 수 없습니다.'
  const operationReason = unavailableReason ?? (!state?.hasSelection ? '감쌀 코드 영역을 먼저 선택하세요.' : undefined)

  return (
    <div className="flex items-center gap-0.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={unavailableReason ? `Primitive: ${unavailableReason}` : 'Primitive'}
            className="h-[68px] w-16 flex-col gap-1 px-1"
            disabled={!state}
            title={unavailableReason}
            type="button"
            variant="ghost"
          >
            <span className="flex h-8 items-center">
              <Shapes className="!size-7" />
              <ChevronDown className="!size-3" />
            </span>
            <span className="w-full truncate text-[11px]">Primitive</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {primitiveAuthoringElements.map((element) => (
            <DropdownMenuItem key={element.tag} onSelect={() => state?.handle.insertPrimitive(element)}>
              <span className="font-mono font-medium">{element.authoringName}</span>
              <span className="ml-3 text-xs text-muted-foreground">{element.summary}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={operationReason ? `Operation: ${operationReason}` : 'Operation'}
            className="h-[68px] w-16 flex-col gap-1 px-1"
            disabled={Boolean(operationReason)}
            title={operationReason}
            type="button"
            variant="ghost"
          >
            <span className="flex h-8 items-center">
              <Braces className="!size-7" />
              <ChevronDown className="!size-3" />
            </span>
            <span className="w-full truncate text-[11px]">Operation</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {operationAuthoringElements.map((element) => (
            <DropdownMenuItem key={element.tag} onSelect={() => state?.handle.wrapSelection(element)}>
              <span className="font-mono font-medium">{element.authoringName}</span>
              <span className="ml-3 text-xs text-muted-foreground">{element.summary}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
