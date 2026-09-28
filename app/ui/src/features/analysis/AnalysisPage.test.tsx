import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AnalysisWorkspace } from './AnalysisPage'
import type { AnalysisProfile, AnalysisRelationshipPlot } from './analysis-types'

const requestRelationshipPlot = vi.hoisted(() => vi.fn())
const restartWorker = vi.hoisted(() => vi.fn())

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
vi.mock('./useAnalysisController', () => ({
  useAnalysisController: () => ({
    busy: null,
    exploreInputKey: 'input',
    exploreTargetKey: 'target',
    profile,
    relationshipOffset: 0,
    relationshipPlot,
    requestRelationshipPlot,
    restartWorker,
    stale: true,
    error: 'test failure',
  }),
}))

describe('Analysis scatter selection', () => {
  it('has no retired views or export actions and preserves reload and retry', () => {
    const { rerender } = render(<AnalysisWorkspace experimentId={7} command={{ id: 1, type: 'reload' }} />)
    expect(restartWorker).toHaveBeenCalledOnce()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Mining|Data CSV|선택 데이터 CSV/ })).not.toBeInTheDocument()
    expect(screen.getByText('Analysis · Explore')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '새로 불러오기' }))
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(restartWorker).toHaveBeenCalledTimes(3)
    rerender(<AnalysisWorkspace experimentId={7} command={{ id: 1, type: 'reload' }} />)
    expect(restartWorker).toHaveBeenCalledTimes(3)
    rerender(<AnalysisWorkspace experimentId={7} command={{ id: 2, type: 'reload' }} />)
    expect(restartWorker).toHaveBeenCalledTimes(4)
  })
  it('searches the two Explore lists independently and selects a relationship from the settings panel', () => {
    const settingsContainer = document.createElement('div')
    document.body.append(settingsContainer)
    try {
      render(<AnalysisWorkspace experimentId={7} settingsContainer={settingsContainer} embedded />)
      const input = within(settingsContainer).getByRole('listbox', { name: 'Input variable' })
      const target = within(settingsContainer).getByRole('listbox', { name: 'Calculation Data' })
      fireEvent.change(screen.getByRole('textbox', { name: 'Input variable 검색' }), { target: { value: 'missing' } })
      expect(within(input).queryByRole('option')).not.toBeInTheDocument()
      expect(within(target).getByRole('option', { name: /Power/ })).toBeInTheDocument()
      fireEvent.change(screen.getByRole('textbox', { name: 'Input variable 검색' }), { target: { value: 'Length' } })
      fireEvent.click(within(input).getByRole('option', { name: /Length/ }))
      expect(requestRelationshipPlot).toHaveBeenLastCalledWith('input', 'target')
      fireEvent.click(within(target).getByRole('option', { name: /Power/ }))
      expect(requestRelationshipPlot).toHaveBeenLastCalledWith('input', 'target')
    } finally {
      settingsContainer.remove()
    }
  })

  it('selects a Measurement in Explore and reflects only committed selection', () => {
    const onSelectMeasurement = vi.fn()
    const props = { experimentId: 7, onSelectMeasurement, selectedMeasurementId: 41 }
    const { rerender } = render(<AnalysisWorkspace {...props} />)
    const chart = screen.getByRole('group', {
      name: 'Length와 Power 산점도',
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

    fireEvent.click(second)
    fireEvent.click(chart)
    expect(onSelectMeasurement.mock.calls).toEqual([[42], [42]])
    expect(second).toHaveAttribute('aria-pressed', 'true')
  })

  it('supports keyboard selection in Explore without resetting settings', async () => {
    const user = userEvent.setup()
    const onSelectMeasurement = vi.fn()
    render(<AnalysisWorkspace experimentId={7} onSelectMeasurement={onSelectMeasurement} />)
    const setting = screen.getByRole('textbox', {
      name: 'Input variable 검색',
    })
    fireEvent.change(setting, { target: { value: 'Length' } })
    const first = screen.getByRole('button', { name: /^Measurement #41/ })
    const second = screen.getByRole('button', { name: /^Measurement #42/ })
    first.focus()
    await user.keyboard('{Enter}')
    await user.tab()
    expect(second).toHaveFocus()
    await user.keyboard(' ')

    expect(onSelectMeasurement.mock.calls).toEqual([[41], [42]])
    expect(setting).toHaveValue('Length')
  })

  it('keeps a chart without a selection callback non-interactive', () => {
    render(<AnalysisWorkspace experimentId={7} />)
    const chart = screen.getByRole('img', { name: 'Length와 Power 산점도' })
    expect(within(chart).queryByRole('button')).not.toBeInTheDocument()
    expect(chart.querySelector('[tabindex]')).toBeNull()
  })
})
