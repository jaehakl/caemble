import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from '@/components/ui/menubar'
import type { WorkbenchMenuDefinition, WorkbenchMenuNode } from './actions'

function MenuNode({ node }: { node: WorkbenchMenuNode }) {
  if (node.type === 'separator') return <MenubarSeparator />

  if (node.type === 'submenu') {
    return (
      <MenubarSub>
        <MenubarSubTrigger>{node.label}</MenubarSubTrigger>
        <MenubarSubContent>
          {node.items.map((item) => (
            <MenuNode key={item.type === 'action' ? item.action.id : item.id} node={item} />
          ))}
        </MenubarSubContent>
      </MenubarSub>
    )
  }

  const { action } = node
  const accessibleLabel =
    action.disabled && action.disabledReason ? `${action.label}: ${action.disabledReason}` : action.label
  return (
    <MenubarItem
      aria-label={accessibleLabel}
      disabled={action.disabled}
      onSelect={action.onSelect}
      title={action.disabledReason}
    >
      {action.icon ? <span aria-hidden="true">{action.icon}</span> : null}
      <span>{action.label}</span>
      {action.shortcut ? <MenubarShortcut>{action.shortcut}</MenubarShortcut> : null}
    </MenubarItem>
  )
}

export function WorkbenchMenubar({
  menus,
  ariaLabel = 'CAE 워크벤치 메뉴',
}: {
  menus: readonly WorkbenchMenuDefinition[]
  ariaLabel?: string
}) {
  return (
    <Menubar aria-label={ariaLabel} className="rounded-none border-x-0 border-t-0 shadow-none">
      {menus.map((menu) => (
        <MenubarMenu key={menu.id}>
          <MenubarTrigger>{menu.label}</MenubarTrigger>
          <MenubarContent>
            {menu.items.map((item) => (
              <MenuNode key={item.type === 'action' ? item.action.id : item.id} node={item} />
            ))}
          </MenubarContent>
        </MenubarMenu>
      ))}
    </Menubar>
  )
}
