import { Input } from '@/components/ui/input'
import {
  defaultKnnAlgorithm,
  defaultMlpAlgorithm,
  predictionAlgorithmSchema,
  type PredictionAlgorithm,
} from '@caemble/execution/prediction/modelDefinition'

export function PredictionAlgorithmSettings({
  algorithm,
  onChange,
}: Readonly<{
  algorithm: PredictionAlgorithm
  onChange: (algorithm: PredictionAlgorithm) => void
}>) {
  const update = (value: PredictionAlgorithm) => {
    const parsed = predictionAlgorithmSchema.safeParse(value)
    if (parsed.success) onChange(parsed.data)
  }
  return (
    <fieldset className="space-y-3 text-sm">
      <legend>학습 알고리즘</legend>
      <select
        aria-label="새 모델 알고리즘"
        className="rounded border bg-background p-1"
        value={algorithm.kind}
        onChange={(event) =>
          onChange(
            event.target.value === 'mlp'
              ? { ...defaultMlpAlgorithm, hiddenLayers: [...defaultMlpAlgorithm.hiddenLayers] }
              : defaultKnnAlgorithm,
          )
        }
      >
        <option value="knn">kNN</option>
        <option value="mlp">MLP · 다층 신경망</option>
      </select>
      {algorithm.kind === 'knn' ? (
        <div className="flex flex-wrap gap-3">
          <label>
            이웃 수
            <select
              aria-label="새 모델 이웃 수 방식"
              className="ml-2 rounded border bg-background p-1"
              value={algorithm.kMode}
              onChange={(event) => update({ ...algorithm, kMode: event.target.value as 'auto' | 'manual' })}
            >
              <option value="auto">자동 k</option>
              <option value="manual">직접 지정</option>
            </select>
          </label>
          {algorithm.kMode === 'manual' && (
            <Input
              aria-label="새 모델 k"
              type="number"
              min={1}
              step={1}
              className="w-24"
              value={algorithm.manualK}
              onChange={(event) => update({ ...algorithm, manualK: Number(event.target.value) })}
            />
          )}
          <label>
            이웃 가중 방식
            <select
              aria-label="새 모델 거리 가중 방식"
              className="ml-2 rounded border bg-background p-1"
              value={algorithm.weighting}
              onChange={(event) => update({ ...algorithm, weighting: event.target.value as 'distance' | 'uniform' })}
            >
              <option value="distance">거리</option>
              <option value="uniform">균등</option>
            </select>
          </label>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            은닉층 수
            <select
              aria-label="MLP 은닉층 수"
              className="ml-2 rounded border bg-background p-1"
              value={algorithm.hiddenLayers.length}
              onChange={(event) =>
                update({
                  ...algorithm,
                  hiddenLayers: Array.from(
                    { length: Number(event.target.value) },
                    (_, index) => algorithm.hiddenLayers[index] ?? 32,
                  ),
                })
              }
            >
              {[1, 2, 3, 4].map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </label>
          {algorithm.hiddenLayers.map((width, index) => (
            <label key={index}>
              은닉층 {index + 1} 너비
              <Input
                aria-label={`MLP 은닉층 ${index + 1} 너비`}
                type="number"
                min={1}
                max={256}
                step={1}
                value={width}
                onChange={(event) =>
                  update({
                    ...algorithm,
                    hiddenLayers: algorithm.hiddenLayers.map((current, position) =>
                      position === index ? Number(event.target.value) : current,
                    ),
                  })
                }
              />
            </label>
          ))}
          <label>
            학습 반복 횟수
            <Input
              aria-label="MLP 학습 반복 횟수"
              type="number"
              min={1}
              max={10_000}
              step={1}
              value={algorithm.epochs}
              onChange={(event) => update({ ...algorithm, epochs: Number(event.target.value) })}
            />
          </label>
          <label>
            배치 크기
            <Input
              aria-label="MLP 배치 크기"
              type="number"
              min={1}
              max={4096}
              step={1}
              value={algorithm.batchSize}
              onChange={(event) => update({ ...algorithm, batchSize: Number(event.target.value) })}
            />
          </label>
          <label>
            학습률
            <Input
              aria-label="MLP 학습률"
              type="number"
              min={0}
              max={1}
              step="any"
              value={algorithm.learningRate}
              onChange={(event) => update({ ...algorithm, learningRate: Number(event.target.value) })}
            />
          </label>
          <label>
            난수 시드
            <Input
              aria-label="MLP 난수 시드"
              type="number"
              min={0}
              max={2_147_483_647}
              step={1}
              value={algorithm.seed}
              onChange={(event) => update({ ...algorithm, seed: Number(event.target.value) })}
            />
          </label>
        </div>
      )}
    </fieldset>
  )
}
