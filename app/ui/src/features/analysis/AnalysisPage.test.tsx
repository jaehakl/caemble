import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AnalysisWorkspace } from './AnalysisPage'
import type { AnalysisMiningResult, AnalysisProfile, AnalysisRelationshipPlot } from './analysis-types'

vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false }),
}))

const profile: AnalysisProfile = {
  fingerprint: 'profile',
  experimentId: 7,
  rowCount: 2,
  measurementCount: 2,
  calculationDataCount: 2,
  calculationCount: 1,
  warnings: [],
  columns: [
    {
      key: 'input',
      label: 'measurement.vars.Length',
      kind: 'feature',
      source: 'measurement-vars',
      count: 2,
      distinctCount: 2,
      missingRatio: 0,
      eligible: true,
    },
    {
      key: 'target',
      label: 'Power',
      kind: 'target',
      source: 'calculation-data',
      count: 2,
      distinctCount: 2,
      missingRatio: 0,
      eligible: true,
    },
  ],
}
const relationshipPlot: AnalysisRelationshipPlot = {
  fingerprint: 'profile',
  inputKey: 'input',
  targetKey: 'target',
  pearson: null,
  spearman: null,
  count: 2,
  points: [
    { measurementId: 41, x: 1, y: 2 },
    { measurementId: 42, x: 3, y: 4 },
  ],
}
const mining: AnalysisMiningResult = {
  fingerprint: 'profile',
  featureKeys: ['input'],
  explainedVariance: [0.8, 0.2],
  loadings: [],
  clusterCount: 2,
  silhouette: 0.5,
  outlierFraction: 0.05,
  points: relationshipPlot.points.map((point, index) => ({
    measurementId: point.measurementId,
    inputFingerprint: `input-${index}`,
    pc1: point.x,
    pc2: point.y,
    cluster: index,
    anomalyScore: index,
    outlier: index === 1,
  })),
}

vi.mock('./useAnalysisController', () => ({
  useAnalysisController: () => ({
    busy: null,
    dataColumnKeys: [],
    exploreInputKey: 'input',
    exploreTargetKey: 'target',
    mining,
    miningFeatureKeys: ['input'],
    profile,
    relationshipOffset: 0,
    relationshipPlot,
  }),
}))

describe('Analysis scatter selection', () => {
  it.each(['explore', 'mining'] as const)(
    'selects a Measurement in %s and reflects only committed selection',
    (tab) => {
      const onSelectMeasurement = vi.fn()
      const props = { experimentId: 7, tab, onSelectMeasurement, selectedMeasurementId: 41 }
      const { rerender } = render(<AnalysisWorkspace {...props} />)
      const chart = screen.getByRole('group', {
        name: tab === 'explore' ? 'Length와 Power 산점도' : 'PCA 2D projection',
      })
      const first = within(chart).getByRole('button', { name: /^Measurement #41/ })
      const second = within(chart).getByRole('button', { name: /^Measurement #42/ })
      const appearance = second.lastElementChild?.outerHTML

      expect(first).toHaveAttribute('aria-pressed', 'true')
      expect(second).toHaveAttribute('aria-pressed', 'false')
      fireEvent.click(second)
      expect(onSelectMeasurement).toHaveBeenLastCalledWith(42)
      expect(first).toHaveAttribute('aria-pressed', 'true')
      expect(second).toHaveAttribute('aria-pressed', 'false')

      rerender(<AnalysisWorkspace {...props} selectedMeasurementId={42} />)
      expect(first).toHaveAttribute('aria-pressed', 'false')
      expect(second).toHaveAttribute('aria-pressed', 'true')
      expect(second.querySelector('.stroke-foreground')).toHaveClass('opacity-100')
      expect(second.lastElementChild?.outerHTML).toBe(appearance)
      expect(screen.getByRole('tab', { selected: true })).toHaveTextContent(tab === 'explore' ? 'Explore' : 'Mining')

      fireEvent.click(second)
      fireEvent.click(chart)
      expect(onSelectMeasurement.mock.calls).toEqual([[42], [42]])
      expect(second).toHaveAttribute('aria-pressed', 'true')
    },
  )

  it.each(['explore', 'mining'] as const)(
    'supports keyboard selection in %s without resetting settings',
    async (tab) => {
      const user = userEvent.setup()
      const onSelectMeasurement = vi.fn()
      render(<AnalysisWorkspace experimentId={7} tab={tab} onSelectMeasurement={onSelectMeasurement} />)
      const setting = screen.getByRole(tab === 'explore' ? 'textbox' : 'slider', {
        name: tab === 'explore' ? 'Input variable 검색' : '이상치 비율',
      })
      fireEvent.change(setting, { target: { value: tab === 'explore' ? 'Length' : '8' } })
      const first = screen.getByRole('button', { name: /^Measurement #41/ })
      const second = screen.getByRole('button', { name: /^Measurement #42/ })
      first.focus()
      await user.keyboard('{Enter}')
      await user.tab()
      expect(second).toHaveFocus()
      await user.keyboard(' ')

      expect(onSelectMeasurement.mock.calls).toEqual([[41], [42]])
      expect(setting).toHaveValue(tab === 'explore' ? 'Length' : '8')
    },
  )

  it('keeps a chart without a selection callback non-interactive', () => {
    render(<AnalysisWorkspace experimentId={7} />)
    const chart = screen.getByRole('img', { name: 'Length와 Power 산점도' })
    expect(within(chart).queryByRole('button')).not.toBeInTheDocument()
    expect(chart.querySelector('[tabindex]')).toBeNull()
  })
})
