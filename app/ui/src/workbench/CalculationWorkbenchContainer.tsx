import { CalculationWorkbench, type CalculationWorkbenchProps } from '@/features/calculation'
import { defaultWorkbenchLayoutState } from '@/features/cae-workbench/types'
import { useWorkbenchShell } from './state/workbenchShellStore'

const defaultColumnRatios = defaultWorkbenchLayoutState.calculationColumnRatios ?? [0.22, 0.26, 0.26, 0.26]
const defaultOutputChartRatio = defaultWorkbenchLayoutState.calculationOutputChartRatio ?? 0.65
const defaultRowRatios = defaultWorkbenchLayoutState.calculationLeftRowRatios ?? [0.45, 0.25, 0.3]

type LayoutProp =
  | 'bottomHeightRatio'
  | 'bottomMode'
  | 'columnRatios'
  | 'onBottomHeightRatioChange'
  | 'onColumnRatiosChange'
  | 'onOutputChartRatioChange'
  | 'onRowRatiosChange'
  | 'outputChartRatio'
  | 'rowRatios'
  | 'viewerExpanded'

export function CalculationWorkbenchContainer(props: Omit<CalculationWorkbenchProps, LayoutProp>) {
  const bottomHeightRatio = useWorkbenchShell((state) => state.layout.bottomHeightRatio)
  const bottomMode = useWorkbenchShell((state) => state.layout.bottomMode)
  const columnRatios = useWorkbenchShell((state) => state.layout.calculationColumnRatios ?? defaultColumnRatios)
  const outputChartRatio = useWorkbenchShell(
    (state) => state.layout.calculationOutputChartRatio ?? defaultOutputChartRatio,
  )
  const rowRatios = useWorkbenchShell((state) => state.layout.calculationLeftRowRatios ?? defaultRowRatios)
  const viewerExpanded = useWorkbenchShell((state) => state.layout.viewerExpanded)
  const setLayout = useWorkbenchShell((state) => state.setLayout)

  return (
    <CalculationWorkbench
      {...props}
      bottomHeightRatio={bottomHeightRatio}
      bottomMode={bottomMode}
      columnRatios={columnRatios}
      outputChartRatio={outputChartRatio}
      rowRatios={rowRatios}
      viewerExpanded={viewerExpanded}
      onBottomHeightRatioChange={(next) => setLayout((layout) => ({ ...layout, bottomHeightRatio: next }))}
      onColumnRatiosChange={(next) => setLayout((layout) => ({ ...layout, calculationColumnRatios: next }))}
      onOutputChartRatioChange={(next) => setLayout((layout) => ({ ...layout, calculationOutputChartRatio: next }))}
      onRowRatiosChange={(next) => setLayout((layout) => ({ ...layout, calculationLeftRowRatios: next }))}
    />
  )
}
