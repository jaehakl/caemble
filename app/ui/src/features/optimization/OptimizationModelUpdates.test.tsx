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
