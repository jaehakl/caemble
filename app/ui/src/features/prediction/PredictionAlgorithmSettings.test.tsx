import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import {
  defaultKnnAlgorithm,
  defaultMlpAlgorithm,
  type PredictionAlgorithm,
} from '@caemble/execution/prediction/modelDefinition'
import { PredictionAlgorithmSettings } from './PredictionAlgorithmSettings'

it('selects MLP and edits its complete bounded recipe without retaining kNN options', () => {
  const changed = vi.fn()
  function Settings() {
    const [algorithm, setAlgorithm] = useState<PredictionAlgorithm>(defaultKnnAlgorithm)
    return (
      <PredictionAlgorithmSettings
        algorithm={algorithm}
        onChange={(value) => {
          changed(value)
          setAlgorithm(value)
        }}
      />
    )
  }
  render(<Settings />)
  fireEvent.change(screen.getByLabelText('새 모델 알고리즘'), { target: { value: 'mlp' } })
  expect(changed).toHaveBeenLastCalledWith(defaultMlpAlgorithm)
  expect(screen.queryByLabelText('새 모델 이웃 수 방식')).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('MLP 은닉층 수'), { target: { value: '3' } })
  fireEvent.change(screen.getByLabelText('MLP 은닉층 3 너비'), { target: { value: '16' } })
  fireEvent.change(screen.getByLabelText('MLP 학습 반복 횟수'), { target: { value: '750' } })
  fireEvent.change(screen.getByLabelText('MLP 배치 크기'), { target: { value: '8' } })
  fireEvent.change(screen.getByLabelText('MLP 학습률'), { target: { value: '0.005' } })
  fireEvent.change(screen.getByLabelText('MLP 난수 시드'), { target: { value: '7' } })
  expect(changed).toHaveBeenLastCalledWith({
    kind: 'mlp',
    hiddenLayers: [32, 32, 16],
    epochs: 750,
    batchSize: 8,
    learningRate: 0.005,
    seed: 7,
  })
  changed.mockClear()
  fireEvent.change(screen.getByLabelText('MLP 은닉층 3 너비'), { target: { value: '257' } })
  expect(changed).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('새 모델 알고리즘'), { target: { value: 'knn' } })
  expect(changed).toHaveBeenLastCalledWith(defaultKnnAlgorithm)
  expect(screen.getByLabelText('새 모델 이웃 수 방식')).toHaveValue('auto')
})
