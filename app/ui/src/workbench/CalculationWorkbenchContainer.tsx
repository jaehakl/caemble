import { CalculationWorkbench, type CalculationWorkbenchProps } from '@/features/calculation'
import { defaultWorkbenchLayoutState } from '@/features/cae-workbench/types'
import { useWorkbenchShell } from './state/workbenchShellStore'

const defaultColumnRatios = defaultWorkbenchLayoutState.calculationColumnRatios ?? [0.3, 0.4, 0.3]
const defaultOutputChartRatio = defaultWorkbenchLayoutState.calculationOutputChartRatio ?? 0.65

type LayoutProp = 'columnRatios' | 'onColumnRatiosChange' | 'onOutputChartRatioChange' | 'outputChartRatio'

export function CalculationWorkbenchContainer(props: Omit<CalculationWorkbenchProps, LayoutProp>) {
  const columnRatios = useWorkbenchShell((state) => state.layout.calculationColumnRatios ?? defaultColumnRatios)
  const outputChartRatio = useWorkbenchShell(
    (state) => state.layout.calculationOutputChartRatio ?? defaultOutputChartRatio,
  )
  const setLayout = useWorkbenchShell((state) => state.setLayout)

  return (
    <CalculationWorkbench
      {...props}
      columnRatios={columnRatios}
      outputChartRatio={outputChartRatio}
      onColumnRatiosChange={(next) => setLayout((layout) => ({ ...layout, calculationColumnRatios: next }))}
      onOutputChartRatioChange={(next) => setLayout((layout) => ({ ...layout, calculationOutputChartRatio: next }))}
    />
  )
}
