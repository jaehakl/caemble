import { WorkbenchShell, type WorkbenchShellProps } from '@/features/cae-workbench/chrome/WorkbenchShell'
import { useWorkbenchShell } from './state/workbenchShellStore'

type LayoutProp =
  | 'bottomHeightRatio'
  | 'bottomMode'
  | 'leftWidthRatio'
  | 'onBottomHeightRatioChange'
  | 'onLeftWidthRatioChange'
  | 'onRightWidthRatioChange'
  | 'rightWidthRatio'
  | 'viewerExpanded'

export function WorkbenchShellContainer(props: Omit<WorkbenchShellProps, LayoutProp>) {
  const bottomHeightRatio = useWorkbenchShell((state) => state.layout.bottomHeightRatio)
  const bottomMode = useWorkbenchShell((state) => state.layout.bottomMode)
  const leftWidthRatio = useWorkbenchShell((state) => state.layout.leftWidthRatio)
  const rightWidthRatio = useWorkbenchShell((state) => state.layout.rightWidthRatio)
  const viewerExpanded = useWorkbenchShell((state) => state.layout.viewerExpanded)
  const setLayout = useWorkbenchShell((state) => state.setLayout)

  return (
    <WorkbenchShell
      {...props}
      bottomHeightRatio={bottomHeightRatio}
      bottomMode={bottomMode}
      leftWidthRatio={leftWidthRatio}
      rightWidthRatio={rightWidthRatio}
      viewerExpanded={viewerExpanded}
      onBottomHeightRatioChange={(next) => setLayout((layout) => ({ ...layout, bottomHeightRatio: next }))}
      onLeftWidthRatioChange={(next) => setLayout((layout) => ({ ...layout, leftWidthRatio: next }))}
      onRightWidthRatioChange={(next) => setLayout((layout) => ({ ...layout, rightWidthRatio: next }))}
    />
  )
}
