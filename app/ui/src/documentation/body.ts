import { CALCULATION_SOURCE_SKELETON } from '@/lib/calculation/declarations'
import { CALCULATION_MATHJS_REFERENCE } from '@/lib/calculation/mathjsManifest'

/** The page heading is displayed by each consumer using the shared page metadata. */
export function documentBody(markdown: string) {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/^# [^\n]+\n+/, '')
    .trimEnd()
}

export function manualBody(markdown: string) {
  return documentBody(markdown)
    .replace('{{calculation.source}}', () => CALCULATION_SOURCE_SKELETON.trimEnd())
    .replace(
      '{{calculation.mathjs}}',
      CALCULATION_MATHJS_REFERENCE.map(
        ({ group, names }) => `- **${group}**: ${names.map((name) => `\`${name}\``).join(', ')}`,
      ).join('\n'),
    )
}
