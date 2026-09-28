import { WorkbenchShell, type WorkbenchShellProps } from '@/features/cae-workbench/chrome/WorkbenchShell'
import { useWorkbenchShell } from './state/workbenchShellStore'
import { defaultWorkbenchLayoutState } from '@/features/cae-workbench/types'

type LayoutProp = 'leftWidthRatio' | 'onLeftWidthRatioChange' | 'onRightWidthRatioChange' | 'rightWidthRatio'

export function WorkbenchShellContainer(props: Omit<WorkbenchShellProps, LayoutProp>) {
  const analysis = useWorkbenchShell((state) => state.layout.activeSection === 'analysis')
  const leftWidthRatio = useWorkbenchShell((state) =>
    analysis
      ? (state.layout.analysisLeftWidthRatio ?? defaultWorkbenchLayoutState.analysisLeftWidthRatio)
      : state.layout.leftWidthRatio,
  )
  const rightWidthRatio = useWorkbenchShell((state) => state.layout.rightWidthRatio)
  const setLayout = useWorkbenchShell((state) => state.setLayout)

  return (
    <WorkbenchShell
      {...props}
      leftWidthRatio={leftWidthRatio}
      rightWidthRatio={rightWidthRatio}
      onLeftWidthRatioChange={(next) =>
        setLayout((layout) => ({ ...layout, [analysis ? 'analysisLeftWidthRatio' : 'leftWidthRatio']: next }))
      }
      onRightWidthRatioChange={(next) => setLayout((layout) => ({ ...layout, rightWidthRatio: next }))}
    />
  )
}
