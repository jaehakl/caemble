import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { PredictionCalculationPane } from './PredictionPanels'
import { calculation, provenance } from './forward.fixture'

vi.mock('@/components/tensor-editor', () => ({
  TensorEditor: ({ disabled }: { disabled: boolean }) => <input aria-label="계산 결과" disabled={disabled} />,
}))
it('shows Calculation output as read-only predicted analysis with its model revision', () => {
  render(
    <PredictionCalculationPane
      calculations={[calculation]}
      busy={false}
      actual={[]}
      result={{
        values: { 2: { dtype: 'float64', shape: [], axes: [], data: 15 } },
        errors: {},
        source: {
          kind: 'prediction',
          candidate: { fingerprint: 'vars', sourceHash: 'source', vars: { x: 0.5 } },
          model: provenance,
          modelFingerprint: 'model',
          recordIds: [7],
        },
      }}
    />,
  )
  expect(screen.getByRole('textbox', { name: '계산 결과' })).toBeDisabled()
  expect(screen.getByText('예측 기반 분석 · Model r1')).toBeInTheDocument()
  expect(screen.queryByText(/Target|Inverse/u)).not.toBeInTheDocument()
})
