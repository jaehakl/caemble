import { Braces, ChevronDown, Shapes } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { CadEditorAuthoringState } from '@/features/viewer/editor/CadEditor'
import { operationAuthoringElements, primitiveAuthoringElements } from '@/lib/cad'

export function GeometryAuthoringRibbon({ state }: { state: CadEditorAuthoringState | null }) {
  const unavailableReason = state ? undefined : '현재 Editor에서는 Geometry source를 편집할 수 없습니다.'
  const operationReason = unavailableReason ?? (!state?.hasSelection ? '감쌀 코드 영역을 먼저 선택하세요.' : undefined)

  return (
    <div className="flex items-center gap-1 border-l pl-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={unavailableReason ? `Primitive: ${unavailableReason}` : 'Primitive'}
            disabled={!state}
            size="sm"
            title={unavailableReason}
            type="button"
            variant="ghost"
          >
            <Shapes className="size-4" /> Primitive <ChevronDown className="size-3" />
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
            disabled={Boolean(operationReason)}
            size="sm"
            title={operationReason}
            type="button"
            variant="ghost"
          >
            <Braces className="size-4" /> Operation <ChevronDown className="size-3" />
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
