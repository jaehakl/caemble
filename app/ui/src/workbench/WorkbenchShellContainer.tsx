import { WorkbenchShell, type WorkbenchShellProps } from '@/features/cae-workbench/chrome/WorkbenchShell'
import { useWorkbenchShell } from './state/workbenchShellStore'

type LayoutProp =
  'leftWidthRatio' | 'onLeftWidthRatioChange' | 'onRightWidthRatioChange' | 'rightWidthRatio' | 'viewerExpanded'

export function WorkbenchShellContainer(props: Omit<WorkbenchShellProps, LayoutProp>) {
  const leftWidthRatio = useWorkbenchShell((state) => state.layout.leftWidthRatio)
  const rightWidthRatio = useWorkbenchShell((state) => state.layout.rightWidthRatio)
  const viewerExpanded = useWorkbenchShell((state) => state.layout.viewerExpanded)
  const setLayout = useWorkbenchShell((state) => state.setLayout)

  return (
    <WorkbenchShell
      {...props}
      leftWidthRatio={leftWidthRatio}
      rightWidthRatio={rightWidthRatio}
      viewerExpanded={viewerExpanded}
      onLeftWidthRatioChange={(next) => setLayout((layout) => ({ ...layout, leftWidthRatio: next }))}
      onRightWidthRatioChange={(next) => setLayout((layout) => ({ ...layout, rightWidthRatio: next }))}
    />
  )
}
