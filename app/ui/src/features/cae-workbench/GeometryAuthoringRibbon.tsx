import { Braces, ChevronDown, Shapes } from 'lucide-react'
import { WorkbenchRibbonButton } from './chrome/WorkbenchRibbon'
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
          <WorkbenchRibbonButton
            aria-label={unavailableReason ? `도형: ${unavailableReason}` : '도형'}
            size="large"
            disabled={!state}
            title={unavailableReason}
            type="button"
            icon={<Shapes />}
            label={
              <span className="flex items-center justify-center gap-1">
                도형 <ChevronDown className="size-3" />
              </span>
            }
          />
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
          <WorkbenchRibbonButton
            aria-label={operationReason ? `연산: ${operationReason}` : '연산'}
            size="large"
            disabled={Boolean(operationReason)}
            title={operationReason}
            type="button"
            icon={<Braces />}
            label={
              <span className="flex items-center justify-center gap-1">
                연산 <ChevronDown className="size-3" />
              </span>
            }
          />
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
