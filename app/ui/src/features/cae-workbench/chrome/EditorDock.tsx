import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, X } from 'lucide-react'
import { useId, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type EditorDockTab = Readonly<{
  id: string
  label: string
  content: ReactNode
  closeable?: boolean
}>

function SortableEditorTab({
  active,
  disabled,
  onActivate,
  onClose,
  onMoveByKeyboard,
  onTabKeyDown,
  panelId,
  tab,
  tabId,
}: {
  active: boolean
  disabled: boolean
  onActivate: () => void
  onClose?: () => void
  onMoveByKeyboard: (direction: -1 | 1) => void
  onTabKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
  panelId: string
  tab: EditorDockTab
  tabId: string
}) {
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    id: tab.id,
    disabled,
  })

  return (
    <div
      className={cn(
        'flex h-9 shrink-0 items-center border-r border-border bg-muted/30 pl-0.5',
        active && 'bg-background',
        isDragging && 'z-10 opacity-70 shadow-md',
      )}
      ref={setNodeRef}
      role="presentation"
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        {...attributes}
        {...listeners}
        aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
        aria-label={`${tab.label} 탭 이동`}
        className="flex size-7 cursor-grab items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:pointer-events-none disabled:opacity-40"
        disabled={disabled}
        onKeyDown={(event) => {
          if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            event.preventDefault()
            onMoveByKeyboard(event.key === 'ArrowLeft' ? -1 : 1)
            return
          }
          listeners?.onKeyDown?.(event)
        }}
        title="드래그하거나 Alt+왼쪽/오른쪽 화살표로 이동"
        type="button"
      >
        <GripVertical aria-hidden="true" className="size-3.5" />
      </button>
      <button
        aria-controls={panelId}
        aria-selected={active}
        className={cn(
          'h-full min-w-20 px-2 text-left text-xs font-medium outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
          active ? 'text-foreground' : 'text-muted-foreground',
        )}
        id={tabId}
        onClick={onActivate}
        onKeyDown={onTabKeyDown}
        role="tab"
        tabIndex={active ? 0 : -1}
        type="button"
      >
        {tab.label}
      </button>
      {onClose ? (
        <button
          aria-label={`${tab.label} 탭 닫기`}
          className="mr-1 flex size-6 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
          type="button"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

export function EditorDock({
  tabs,
  activeTabId,
  onActiveTabChange,
  onTabsReorder,
  onTabClose,
  ariaLabel = 'CAE Editor 탭',
  emptyContent = '열린 Editor 탭이 없습니다.',
  className,
}: {
  tabs: readonly EditorDockTab[]
  activeTabId: string | null
  onActiveTabChange: (tabId: string) => void
  onTabsReorder: (tabIds: readonly string[]) => void
  onTabClose?: (tabId: string) => void
  ariaLabel?: string
  emptyContent?: ReactNode
  className?: string
}) {
  const dockId = useId()
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const tabIds = tabs.map((tab) => tab.id)
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null

  const tabDomId = (tabId: string) => `${dockId}-tab-${encodeURIComponent(tabId)}`
  const panelDomId = (tabId: string) => `${dockId}-panel-${encodeURIComponent(tabId)}`

  const moveTab = (tabId: string, direction: -1 | 1) => {
    const index = tabIds.indexOf(tabId)
    const nextIndex = index + direction
    if (index < 0 || nextIndex < 0 || nextIndex >= tabIds.length) return
    onTabsReorder(arrayMove(tabIds, index, nextIndex))
  }

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const oldIndex = tabIds.indexOf(String(active.id))
    const newIndex = tabIds.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    onTabsReorder(arrayMove(tabIds, oldIndex, newIndex))
  }

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = tabs.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const nextTab = tabs[nextIndex]
    if (!nextTab) return
    onActiveTabChange(nextTab.id)
    document.getElementById(tabDomId(nextTab.id))?.focus()
  }

  return (
    <section className={cn('flex min-h-0 min-w-0 flex-1 flex-col bg-background', className)}>
      <DndContext
        accessibility={{
          screenReaderInstructions: {
            draggable: '탭 이동 버튼에서 스페이스바를 누르고 화살표 키로 위치를 바꾼 뒤 스페이스바를 다시 누르세요.',
          },
        }}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
        sensors={sensors}
      >
        <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
          <div aria-label={ariaLabel} className="flex shrink-0 overflow-x-auto border-b bg-muted/20" role="tablist">
            {tabs.map((tab, index) => (
              <SortableEditorTab
                active={tab.id === activeTabId}
                disabled={tabs.length < 2}
                key={tab.id}
                onActivate={() => onActiveTabChange(tab.id)}
                onClose={onTabClose && tab.closeable !== false ? () => onTabClose(tab.id) : undefined}
                onMoveByKeyboard={(direction) => moveTab(tab.id, direction)}
                onTabKeyDown={(event) => handleTabKeyDown(event, index)}
                panelId={panelDomId(tab.id)}
                tab={tab}
                tabId={tabDomId(tab.id)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {activeTab ? (
        <div
          aria-labelledby={tabDomId(activeTab.id)}
          className="min-h-0 flex-1 overflow-auto outline-none"
          id={panelDomId(activeTab.id)}
          role="tabpanel"
          tabIndex={0}
        >
          {activeTab.content}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          {emptyContent}
        </div>
      )}
    </section>
  )
}
