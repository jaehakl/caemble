import * as MenubarPrimitive from '@radix-ui/react-menubar'
import { Check, ChevronRight } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export const MenubarMenu = MenubarPrimitive.Menu
export const MenubarGroup = MenubarPrimitive.Group
export const MenubarPortal = MenubarPrimitive.Portal
export const MenubarSub = MenubarPrimitive.Sub
export const MenubarRadioGroup = MenubarPrimitive.RadioGroup

export function Menubar({ className, ...props }: ComponentProps<typeof MenubarPrimitive.Root>) {
  return (
    <MenubarPrimitive.Root
      className={cn(
        'flex h-9 items-center gap-1 rounded-md border border-border bg-background p-1 shadow-xs',
        className,
      )}
      {...props}
    />
  )
}

export function MenubarTrigger({ className, ...props }: ComponentProps<typeof MenubarPrimitive.Trigger>) {
  return (
    <MenubarPrimitive.Trigger
      className={cn(
        'flex cursor-default items-center rounded-sm px-2.5 py-1 text-sm font-medium outline-none select-none focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground',
        className,
      )}
      {...props}
    />
  )
}

export function MenubarContent({
  className,
  align = 'start',
  alignOffset = -4,
  sideOffset = 8,
  ...props
}: ComponentProps<typeof MenubarPrimitive.Content>) {
  return (
    <MenubarPrimitive.Portal>
      <MenubarPrimitive.Content
        align={align}
        alignOffset={alignOffset}
        className={cn(
          'z-50 min-w-48 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md',
          className,
        )}
        sideOffset={sideOffset}
        {...props}
      />
    </MenubarPrimitive.Portal>
  )
}

export function MenubarItem({
  className,
  inset,
  ...props
}: ComponentProps<typeof MenubarPrimitive.Item> & { inset?: boolean }) {
  return (
    <MenubarPrimitive.Item
      className={cn(
        'relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        inset && 'pl-8',
        className,
      )}
      {...props}
    />
  )
}

export function MenubarSubTrigger({
  className,
  inset,
  children,
  ...props
}: ComponentProps<typeof MenubarPrimitive.SubTrigger> & { inset?: boolean }) {
  return (
    <MenubarPrimitive.SubTrigger
      className={cn(
        'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground',
        inset && 'pl-8',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight aria-hidden="true" className="ml-auto size-4" />
    </MenubarPrimitive.SubTrigger>
  )
}

export function MenubarSubContent({ className, ...props }: ComponentProps<typeof MenubarPrimitive.SubContent>) {
  return (
    <MenubarPrimitive.SubContent
      className={cn(
        'z-50 min-w-44 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md',
        className,
      )}
      {...props}
    />
  )
}

export function MenubarCheckboxItem({
  className,
  children,
  checked,
  ...props
}: ComponentProps<typeof MenubarPrimitive.CheckboxItem>) {
  return (
    <MenubarPrimitive.CheckboxItem
      checked={checked}
      className={cn(
        'relative flex cursor-default items-center rounded-sm py-1.5 pr-2 pl-8 text-sm outline-none select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <MenubarPrimitive.ItemIndicator>
          <Check aria-hidden="true" className="size-4" />
        </MenubarPrimitive.ItemIndicator>
      </span>
      {children}
    </MenubarPrimitive.CheckboxItem>
  )
}

export function MenubarLabel({
  className,
  inset,
  ...props
}: ComponentProps<typeof MenubarPrimitive.Label> & { inset?: boolean }) {
  return (
    <MenubarPrimitive.Label
      className={cn('px-2 py-1.5 text-xs font-semibold text-muted-foreground', inset && 'pl-8', className)}
      {...props}
    />
  )
}

export function MenubarSeparator({ className, ...props }: ComponentProps<typeof MenubarPrimitive.Separator>) {
  return <MenubarPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />
}

export function MenubarShortcut({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('ml-auto text-xs tracking-widest text-muted-foreground', className)} {...props} />
}
