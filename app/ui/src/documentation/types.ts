export type ManualSection = 'workbench' | 'program' | 'reference' | 'troubleshooting'

export type DocumentPage = Readonly<{
  id: string
  title: string
  summary: string
  content: string
  sourcePath: string
  keywords: readonly string[]
  section?: ManualSection
  anchor?: string
  aliases?: readonly string[]
  collapsed?: boolean
}>
