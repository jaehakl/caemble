import { describe, expect, it } from 'vitest'
import { cadElementCatalog } from '@/lib/cad'
import { getDocsKnowledge } from '@/pages/docs/docsKnowledge'
import {
  CAD_GRAMMAR_CORE,
  CAD_GRAMMAR_CORE_MAX_BYTES,
  cadReferenceSearchHints,
  selectAiReferenceDocs,
} from './cadReference'

describe('official AI CAD reference', () => {
  it('keeps the complete v7 grammar and every registered intrinsic within 5 KiB', () => {
    expect(new TextEncoder().encode(CAD_GRAMMAR_CORE).byteLength).toBeLessThanOrEqual(CAD_GRAMMAR_CORE_MAX_BYTES)
    expect(CAD_GRAMMAR_CORE).toContain('API v7')
    expect(CAD_GRAMMAR_CORE).toContain('position?: Vec3')
    expect(CAD_GRAMMAR_CORE).toContain('rotation?: Vec3')
    expect(CAD_GRAMMAR_CORE).toContain("from '@caemble/core'")
    expect(CAD_GRAMMAR_CORE).toContain('Never generate `translation`')
    expect(CAD_GRAMMAR_CORE).toContain('deprecated v7 compatibility properties for legacy source')
    expect(CAD_GRAMMAR_CORE).not.toContain('migration-only v6 properties')
    expect(CAD_GRAMMAR_CORE.split('## Intrinsic tag index')[1]).not.toMatch(/\b(?:pos|rotate)=/u)
    cadElementCatalog.forEach(({ syntax, tag }) => {
      expect(CAD_GRAMMAR_CORE).toContain(`\`${tag}\``)
      expect(CAD_GRAMMAR_CORE).toContain(`\`${syntax}\``)
    })
  })

  it('orders explicit prompt tags before active-source and diagnostic tags', () => {
    const selected = selectAiReferenceDocs({
      activeSource: '<><cylinder radius={2} height={4} /><box size={[1, 2, 3]} /></>',
      diagnostics: 'subtract received an invalid child',
      docsKnowledge: getDocsKnowledge(),
      limit: 20,
      prompt: 'sphere 코드를 작성해 줘',
      recentUserPrompts: [],
    })

    expect(selected.slice(0, 4).map(({ id }) => id)).toEqual([
      'geometry:sphere',
      'geometry:cylinder',
      'geometry:box',
      'geometry:subtract',
    ])
  })

  it('keeps diagnostic search hints within a valid UTF-8 budget', () => {
    const hints = cadReferenceSearchHints('<box size={[1, 2, 3]} />', '한글🙂'.repeat(10_000))

    expect(new TextEncoder().encode(hints).byteLength).toBeLessThanOrEqual(8 * 1024)
    expect(hints).toContain('box')
    expect(hints).not.toContain('\uFFFD')
  })
})
