import { describe, expect, it } from 'vitest'
import { helpHref, legacyDocsHref, readHelpLocation } from './helpNavigation'
import { publicDocuments } from './public'
import { searchDocsKnowledge } from './knowledge'

describe('Help addresses and search', () => {
  it('resolves every published document anchor and alias to its stable ID', () => {
    for (const page of publicDocuments) {
      for (const anchor of [page.anchor, ...(page.aliases ?? [])]) {
        expect(legacyDocsHref(`?section=${page.section}`, `#${anchor}`)).toBe(helpHref('manual', page.id))
      }
    }
    expect(legacyDocsHref('?section=solvers&item=experiment:demo%401', '')).toBe(helpHref('examples', 'demo@1'))
    expect(legacyDocsHref('?section=materials&item=a%2Fb%401', '')).toBe(helpHref('materials', 'a/b@1'))
    expect(legacyDocsHref('?section=unknown', '')).toBe('/?help=home')
    expect(legacyDocsHref('?section=program', '#missing')).toBe(helpHref('manual', 'missing'))
  })
  it('round trips encoded items and heading anchors and leaves ordinary workbench addresses alone', () => {
    const href = helpHref('manual', 'example', '한글 / heading')
    expect(readHelpLocation(href.slice(1))).toEqual({ kind: 'manual', item: 'example', anchor: '한글 / heading' })
    expect(readHelpLocation('?experiment=12')).toBeNull()
    expect(readHelpLocation('?help=invalid')?.kind).toBe('home')
  })
  it('finds words occurring only in a manual body', () => {
    expect(
      searchDocsKnowledge('본문검색전용', [
        {
          id: 'test',
          section: 'program',
          title: '제목',
          summary: '요약',
          keywords: [],
          href: '/?help=manual&item=test',
          content: '본문검색전용 문장',
        },
      ]).map((p) => p.id),
    ).toEqual(['test'])
  })
})
