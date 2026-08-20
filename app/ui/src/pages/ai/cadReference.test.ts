import { describe, expect, it } from 'vitest'
import { CAD_API_DECLARATION_FINGERPRINT, cadElementCatalog } from '@/lib/cad'
import { AI_AGENT_PROMPT_TOOL_VERSION } from '@/api/aiAgent'
import { geometryAuthoringSkeletonCode } from '@/lib/examples'
import { getDocsKnowledge } from '@/pages/docs/docsKnowledge'
import {
  CAD_AUTHORING_REFERENCE,
  CAD_GRAMMAR_CORE,
  CAD_GRAMMAR_CORE_MAX_BYTES,
  cadReferenceSearchHints,
  selectAiReferenceDocs,
} from './cadReference'

describe('official AI CAD reference', () => {
  it('keeps the complete v8 grammar and every registered intrinsic within 5 KiB', () => {
    expect(new TextEncoder().encode(CAD_GRAMMAR_CORE).byteLength).toBeLessThanOrEqual(CAD_GRAMMAR_CORE_MAX_BYTES)
    expect(CAD_GRAMMAR_CORE).toContain('API v8')
    expect(CAD_GRAMMAR_CORE).toContain('position?: Vec3')
    expect(CAD_GRAMMAR_CORE).toContain('rotation?: Vec3')
    expect(CAD_GRAMMAR_CORE).toContain("from '@caemble/core'")
    expect(CAD_GRAMMAR_CORE).toContain(geometryAuthoringSkeletonCode.trim())
    expect(CAD_GRAMMAR_CORE).toContain('Never generate `translation`')
    expect(CAD_GRAMMAR_CORE).toContain('lowercase primitive JSX are deprecated compatibility syntax')
    expect(CAD_GRAMMAR_CORE).toContain('initializer for every custom prop')
    expect(CAD_GRAMMAR_CORE).toContain('omitted/`undefined` uses Catalog defaults')
    expect(CAD_GRAMMAR_CORE).not.toContain('migration-only v6 properties')
    expect(CAD_GRAMMAR_CORE.split('## Element index')[1]).not.toMatch(/\b(?:pos|rotate)=/u)
    cadElementCatalog.forEach(({ authoringName, syntax }) => {
      expect(CAD_GRAMMAR_CORE).toContain(`\`${authoringName}\``)
      expect(CAD_GRAMMAR_CORE).toContain(`\`${syntax}\``)
    })
    expect(CAD_AUTHORING_REFERENCE.declarationFingerprint).toBe(CAD_API_DECLARATION_FINGERPRINT)
    expect(CAD_AUTHORING_REFERENCE.elements).toHaveLength(14)
    expect(CAD_AUTHORING_REFERENCE.elements.map(({ tag }) => tag)).toEqual(cadElementCatalog.map(({ tag }) => tag))
    expect(AI_AGENT_PROMPT_TOOL_VERSION).toMatch(/^caemble-ai-agent-v4-[0-9a-f]{12}$/u)
  })

  it('orders explicit prompt tags before active-source and diagnostic tags', () => {
    const selected = selectAiReferenceDocs({
      activeSource: '<><Cylinder radius={2} height={4} /><Box size={[1, 2, 3]} /></>',
      diagnostics: 'subtract received an invalid child',
      docsKnowledge: getDocsKnowledge(),
      limit: 20,
      prompt: 'Sphere 코드를 작성해 줘',
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
    const hints = cadReferenceSearchHints(
      '<Box size={[1, 2, 3]} /><cylinder radius={1} height={2} />',
      '한글🙂'.repeat(10_000),
    )

    expect(new TextEncoder().encode(hints).byteLength).toBeLessThanOrEqual(8 * 1024)
    expect(hints).toContain('box')
    expect(hints).toContain('cylinder')
    expect(hints).not.toContain('\uFFFD')
  })
})
