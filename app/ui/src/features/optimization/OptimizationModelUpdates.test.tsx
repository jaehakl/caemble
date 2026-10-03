import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { expect, it, vi } from 'vitest'
import { optimizationModelUpdatePolicySchema, optimizationDetailSchema } from '@/contracts/api/optimization'
import { hybridOptimizationFixture } from './fixtures.test-support'
import { OptimizationModelUpdates } from './OptimizationModelUpdates'

it.each(['queued', 'timed_out', 'adopted'])('displays automatic training budget and %s status', (state) => {
  const policy = optimizationModelUpdatePolicySchema.parse({ id: 'new_solver_results' })
  const optimization = optimizationDetailSchema.parse({
    ...hybridOptimizationFixture,
    state: 'running',
    settings: {
      ...hybridOptimizationFixture.settings,
      hybrid: {
        ...hybridOptimizationFixture.settings.hybrid,
        model_update_policy: policy,
      },
    },
    model_update: {
      ...hybridOptimizationFixture.model_update,
      waiting: state === 'queued',
      automatic: {
        version: 1,
        new_measurements: 2,
        attempts: 1,
        elapsed_seconds: 12.5,
        reason: 'insufficient_results',
        error: null,
      },
      updates: [
        {
          request_id: 'request',
          operation_id: 'operation',
          model_id: 'model-1',
          revision: 2,
          version_name: 'Updated model',
          state,
          origin: 'automatic',
          error: state === 'timed_out' ? { message: 'Automatic deadline exceeded.' } : null,
          ...(state === 'adopted' ? { adopted_round: 1 } : {}),
        },
      ],
    },
  })
  render(
    <MemoryRouter>
      <OptimizationModelUpdates optimization={optimization} busy={false} compact={false} onUpdate={vi.fn()} />
    </MemoryRouter>,
  )
  expect(screen.getByLabelText('자동 재학습 상태')).toHaveTextContent('새 결과 2 / 3개')
  expect(screen.getByLabelText('자동 재학습 상태')).toHaveTextContent('갱신 1 / 3회 · 대기·학습 13 / 540초')
  if (state === 'queued') {
    expect(screen.getByRole('button', { name: '모델 갱신' })).toBeDisabled()
    expect(screen.getByText('다음 탐색 회차가 학습 완료와 자원 정리를 기다리고 있습니다.')).toBeInTheDocument()
  } else if (state === 'timed_out') {
    expect(screen.getByRole('alert')).toHaveTextContent('Automatic deadline exceeded.')
    expect(screen.getByRole('button', { name: '모델 갱신' })).toBeEnabled()
  } else {
    expect(screen.getByText('1회차부터 사용')).toBeInTheDocument()
  }
})

it('rejects unsupported policy versions and nonpositive or fractional limits', () => {
  expect(optimizationModelUpdatePolicySchema.safeParse({ id: 'new_solver_results', version: 2 }).success).toBe(false)
  for (const value of [0, -1, 0.5, Infinity, true, '3']) {
    expect(
      optimizationModelUpdatePolicySchema.safeParse({ id: 'new_solver_results', config: { max_updates: value } })
        .success,
    ).toBe(false)
  }
  expect(optimizationDetailSchema.parse(hybridOptimizationFixture).model_update?.automatic).toBeUndefined()
})

it('disables updates for incompatible search state and shows comparable RMSE without changing the verdict', () => {
  const optimization = optimizationDetailSchema.parse({
    ...hybridOptimizationFixture,
    continuation: { supported: false, reason: 'Create a new Optimization.' },
    model_update: {
      ...hybridOptimizationFixture.model_update,
      updates: [
        {
          request_id: 'request',
          operation_id: 'operation',
          model_id: 'model-1',
          revision: 2,
          version_name: 'Updated model',
          state: 'adopted',
          quality_comparison: {
            lineage_fingerprint: 'lineage',
            items: [{ recordId: 10, component: 'value', unit: 'K', previous_rmse: 0.3, current_rmse: 0.4, delta: 0.1 }],
          },
        },
      ],
    },
  })
  render(
    <MemoryRouter>
      <OptimizationModelUpdates optimization={optimization} busy={false} compact={false} onUpdate={vi.fn()} />
    </MemoryRouter>,
  )
  expect(screen.getByRole('button', { name: '모델 갱신' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '모델 갱신' })).toHaveAttribute('title', 'Create a new Optimization.')
  expect(screen.getByLabelText('Updated model 품질 비교')).toHaveTextContent('이전 0.3 → 신규 0.4 · 차이 +0.1 K')
  expect(screen.getByText(/수동 갱신 · Updated model · 채택 완료/)).toBeInTheDocument()
})

it.each([undefined, 1, 2])('keeps fixed-model use separate from quality version %s update eligibility', (version) => {
  const source = {
    ...hybridOptimizationFixture.model_update!.active_model,
    model_definition: version === undefined ? {} : { qualityValidation: { version } },
  }
  const optimization = optimizationDetailSchema.parse({
    ...hybridOptimizationFixture,
    model_update: { ...hybridOptimizationFixture.model_update, active_model: source },
  })
  render(
    <MemoryRouter>
      <OptimizationModelUpdates optimization={optimization} busy={false} compact={false} onUpdate={vi.fn()} />
    </MemoryRouter>,
  )
  const button = screen.getByRole('button', { name: '모델 갱신' })
  if (version === 1) {
    expect(button).toBeDisabled()
    expect(screen.getByText('모델 갱신에는 새 품질 평가 v2 모델이 필요합니다.')).toBeInTheDocument()
  } else expect(button).toBeEnabled()
  expect(screen.getByText('현재 채택 모델')).toBeInTheDocument()
})
