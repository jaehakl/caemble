import { describe, expect, it } from 'vitest'
import { helpHref, readHelpLocation } from './helpNavigation'
import { searchDocsKnowledge } from './knowledge'

describe('Help addresses and search', () => {
  it('builds canonical Documentation addresses', () => {
    expect(helpHref('home')).toBe('/doc?help=home')
    expect(helpHref('examples', 'demo@1')).toBe('/doc?help=examples&item=demo%401')
    expect(helpHref('materials', 'a/b@1')).toBe('/doc?help=materials&item=a%2Fb%401')
  })
  it('round trips encoded items and heading anchors and leaves ordinary workbench addresses alone', () => {
    const href = helpHref('manual', 'example', '한글 / heading')
    expect(readHelpLocation(new URL(href, 'https://caemble.invalid').search)).toEqual({
      kind: 'manual',
      item: 'example',
      anchor: '한글 / heading',
    })
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
          href: '/doc?help=manual&item=test',
          content: '본문검색전용 문장',
        },
      ]).map((p) => p.id),
    ).toEqual(['test'])
  })
})
