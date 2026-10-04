import { describe, expect, it } from 'vitest'
import { fileState } from './modelFiles.fixture'
import {
  predictionFileActionReason,
  predictionFileRows,
  predictionRemovalSummary,
  visiblePredictionFiles,
} from './assetFiles'

describe('model file inventory', () => {
  it('keeps copyless revisions and does not duplicate a storage accessible by two launchers', () => {
    const rows = predictionFileRows(fileState)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ bytes: null, replica: undefined })
    expect(rows[1]).toMatchObject({ bytes: 1000, launcherIds: ['one', 'two'] })
    expect(predictionFileActionReason(rows[0], 'remove')).toBe('복사본 없음')
  })
  it('sorts revision numerically and combines model, Experiment and launcher filters', () => {
    const rows = predictionFileRows(fileState)
    expect(
      visiblePredictionFiles(rows, new URLSearchParams('sort=revision')).map((row) => row.revision.revision),
    ).toEqual([2, 10])
    expect(
      visiblePredictionFiles(rows, new URLSearchParams('sort=revision&order=desc')).map((row) => row.revision.revision),
    ).toEqual([10, 2])
    expect(
      visiblePredictionFiles(rows, new URLSearchParams('q=온도&model=model&experiment=1&launcher=two')),
    ).toHaveLength(1)
    expect(visiblePredictionFiles(rows, new URLSearchParams('experiment=2'))).toHaveLength(0)
    expect(visiblePredictionFiles(rows, new URLSearchParams('state=none'))[0].replica).toBeUndefined()
  })
  it('does not label unavailable sizes zero and computes the last-copy warning across the whole selection', () => {
    const copy = predictionFileRows(fileState)[1]
    const second = { ...copy, key: 'second', replica: { ...copy.replica!, id: 'second' } }
    expect(predictionRemovalSummary([copy, second], [copy])).toContain('복사본 1개')
    expect(predictionRemovalSummary([copy, second], [copy, second])).toContain('복사본 0개')
    const missing = { ...copy, bytes: null }
    expect(visiblePredictionFiles([missing, second], new URLSearchParams('sort=bytes&order=desc'))[1].bytes).toBeNull()
  })
  it('excludes waiting deletions, offline verification and backup verification without hiding their rows', () => {
    const copy = predictionFileRows(fileState)[1]
    expect(
      predictionFileActionReason({ ...copy, replica: { ...copy.replica!, state: 'deleting' } }, 'remove'),
    ).toContain('기존 삭제')
    expect(predictionFileActionReason({ ...copy, storage: { ...copy.storage!, accesses: [] } }, 'verify')).toBe(
      '장비 오프라인',
    )
    expect(
      predictionFileActionReason({ ...copy, storage: { ...copy.storage!, kind: 'object_backup' } }, 'verify'),
    ).toContain('복원')
  })
})
