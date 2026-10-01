import { describe, expect, it } from 'vitest'
import { fileState } from './modelFiles.fixture'
import { modelFileActionReason, modelFileRows, modelRemovalSummary, visibleModelFiles } from './modelFiles'

describe('model file inventory', () => {
  it('keeps copyless revisions and does not duplicate a storage accessible by two launchers', () => {
    const rows = modelFileRows(fileState)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ bytes: null, replica: undefined })
    expect(rows[1]).toMatchObject({ bytes: 1000, launcherIds: ['one', 'two'] })
    expect(modelFileActionReason(rows[0], 'remove')).toBe('복사본 없음')
  })
  it('sorts revision numerically and combines model, Experiment and launcher filters', () => {
    const rows = modelFileRows(fileState)
    expect(visibleModelFiles(rows, new URLSearchParams('sort=revision')).map((row) => row.revision.revision)).toEqual([
      2, 10,
    ])
    expect(
      visibleModelFiles(rows, new URLSearchParams('sort=revision&order=desc')).map((row) => row.revision.revision),
    ).toEqual([10, 2])
    expect(visibleModelFiles(rows, new URLSearchParams('q=온도&model=model&experiment=1&launcher=two'))).toHaveLength(1)
    expect(visibleModelFiles(rows, new URLSearchParams('experiment=2'))).toHaveLength(0)
    expect(visibleModelFiles(rows, new URLSearchParams('state=none'))[0].replica).toBeUndefined()
  })
  it('does not label unavailable sizes zero and computes the last-copy warning across the whole selection', () => {
    const copy = modelFileRows(fileState)[1]
    const second = { ...copy, key: 'second', replica: { ...copy.replica!, id: 'second' } }
    expect(modelRemovalSummary([copy, second], [copy])).toContain('복사본 1개')
    expect(modelRemovalSummary([copy, second], [copy, second])).toContain('복사본 0개')
    const missing = { ...copy, bytes: null }
    expect(visibleModelFiles([missing, second], new URLSearchParams('sort=bytes&order=desc'))[1].bytes).toBeNull()
  })
  it('excludes waiting deletions, offline verification and backup verification without hiding their rows', () => {
    const copy = modelFileRows(fileState)[1]
    expect(modelFileActionReason({ ...copy, replica: { ...copy.replica!, state: 'deleting' } }, 'remove')).toContain(
      '기존 삭제',
    )
    expect(modelFileActionReason({ ...copy, storage: { ...copy.storage!, accesses: [] } }, 'verify')).toBe(
      '장비 오프라인',
    )
    expect(
      modelFileActionReason({ ...copy, storage: { ...copy.storage!, kind: 'object_backup' } }, 'verify'),
    ).toContain('복원')
  })
})
