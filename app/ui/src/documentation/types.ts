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

export const helpKindIds = ['home', 'manual', 'geometry', 'materials', 'quantity-kinds', 'solvers', 'examples'] as const
export type HelpKindId = (typeof helpKindIds)[number]
