export type DocumentHeading = Readonly<{ id: string; title: string; level: number; line: number }>

/** Use the same anchor rules for the outline, Markdown headings and link checks. */
export function documentHeadings(content: string): DocumentHeading[] {
  let fence: string | null = null
  const seen = new Map<string, number>()
  return content.split('\n').flatMap((line, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      return []
    }
    const match = !fence && /^(#{2,4})\s+(.+)/.exec(line)
    if (!match) return []
    const title = match[2].replace(/[`*_]/g, '').trim()
    const base = title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return [{ id: `${base}${count ? `-${count}` : ''}`, title, level: match[1].length, line: index + 1 }]
  })
}
