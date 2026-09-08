// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { documents, searchDocuments } from './index'
import navigation from './navigation.fixture.json'
import { publicDocuments } from './public'
import { documentBody, manualBody } from './body'
import { authoringGuides } from '@/authoring/guides'
import { getAuthoringReference } from '@/authoring'
import { manualDocsKnowledge } from '@/documentation/knowledge'
import { CALCULATION_SOURCE_SKELETON } from '@/lib/calculation/declarations'

const repo = path.resolve('../..')
const maintainedMarkdown = readdirSync(path.join(repo, 'docs'), { recursive: true })
  .filter((file): file is string => typeof file === 'string' && file.endsWith('.md'))
  .map((file) => `docs/${file.replace(/\\/g, '/')}`)
  .filter((file) => !file.startsWith('docs/archive/'))

describe('shared documentation sources', () => {
  it('preserves the existing manual IDs and public anchors', () => {
    expect(
      publicDocuments.map(({ id, section, anchor, aliases }) => ({ id, section, anchor, aliases: aliases ?? [] })),
    ).toEqual(navigation)
    for (const page of manualDocsKnowledge) {
      expect(page.href).toBe(`/?help=manual&item=${page.id}`)
    }
  })

  it('uses the same resolved Markdown in the web manual and CLI registry', () => {
    expect(new Set(documents.map(({ id }) => id)).size).toBe(documents.length)
    expect(documents.map(({ sourcePath }) => sourcePath).sort()).toEqual([...maintainedMarkdown].sort())
    for (const document of documents) {
      const markdown = readFileSync(path.join(repo, document.sourcePath), 'utf8')
      expect(markdown.split(/\r?\n/)[0], document.id).toBe(`# ${document.title}`)
      expect(document.content).toBe(
        document.sourcePath.startsWith('docs/manual/') ? manualBody(markdown) : documentBody(markdown),
      )
      expect(document.sourcePath).not.toContain('/archive/')
    }
    for (const page of manualDocsKnowledge)
      expect(documents.find(({ id }) => id === page.id)?.content, page.id).toBe(page.content)
    for (const guide of authoringGuides) {
      expect(documents.find(({ id }) => id === `authoring-${guide.id}`)?.content).toBe(guide.content)
      for (const file of guide.sourcePaths) expect(existsSync(path.join(repo, file)), file).toBe(true)
      for (const id of guide.referenceIds) expect(getAuthoringReference(id), id).toBeDefined()
    }
  })

  it('keeps runtime fragments live and repository-only documents out of the web manual', () => {
    const calculation = documents.find(({ id }) => id === 'workbench-calculation')!
    expect(calculation.content).toContain(CALCULATION_SOURCE_SKELETON.trimEnd())
    expect(calculation.content).not.toMatch(/\{\{calculation\./)
    expect(searchDocuments('Nginx').some(({ id }) => id === 'operations.deployment')).toBe(true)
    expect(searchDocuments('')).toEqual([])
    expect(publicDocuments.every(({ sourcePath }) => /docs\/(authoring|manual)\//.test(sourcePath))).toBe(true)
  })

  it('resolves maintained Markdown links and required startup instruction targets', () => {
    const files = [
      'README.md',
      'AGENTS.md',
      'app/slaves/cae/AGENTS.md',
      'app/ui/README.md',
      'app/api/README.md',
      'app/slaves/README.md',
      'app/slaves/cae/README.md',
      'app/ui/src/lib/cad/elements/README.md',
      'app/sdk/README.md',
      'app/sdk/master/js/README.md',
      'app/sdk/master/python/README.md',
      ...maintainedMarkdown,
    ]
    const failures: string[] = []
    for (const file of files) {
      const text = readFileSync(path.join(repo, file), 'utf8').replace(
        /(^|\n)(```|~~~)[\s\S]*?\n\2[^\n]*(?=\n|$)/g,
        '\n',
      )
      for (const match of text.replace(/`[^`\n]+`/g, '').matchAll(/\]\(([^\s)]+)\)/g)) {
        const href = match[1]
        if (/^[a-z][a-z\d+.-]*:/i.test(href)) continue
        if (href.startsWith('/?help=')) {
          const url = new URL(href, 'https://caemble.invalid')
          if (
            url.searchParams.get('help') === 'manual' &&
            !publicDocuments.some((page) => page.id === url.searchParams.get('item'))
          )
            failures.push(`${file}: unknown Help document ${href}`)
          continue
        }
        if (href.startsWith('/docs')) {
          const url = new URL(href, 'https://caemble.invalid')
          if (
            url.hash &&
            !publicDocuments.some(
              (page) =>
                page.section === url.searchParams.get('section') &&
                [page.anchor, ...(page.aliases ?? [])].includes(decodeURIComponent(url.hash.slice(1))),
            )
          )
            failures.push(`${file}: unknown web anchor ${href}`)
          continue
        }
        if (href.startsWith('/')) continue
        const [target, anchor] = href.split('#')
        const destination = target
          ? path.resolve(repo, path.dirname(file), decodeURIComponent(target))
          : path.join(repo, file)
        if (!existsSync(destination)) {
          failures.push(`${file}: missing ${href}`)
          continue
        }
        if (anchor && destination.endsWith('.md')) {
          const headings = [...readFileSync(destination, 'utf8').matchAll(/^#{1,6} (.+)$/gm)].map((heading) =>
            heading[1]
              .trim()
              .toLowerCase()
              .replace(/[^\p{L}\p{N}\s_-]/gu, '')
              .replace(/\s/g, '-'),
          )
          if (!headings.includes(decodeURIComponent(anchor))) failures.push(`${file}: missing heading ${href}`)
        }
      }
    }
    expect(failures).toEqual([])
    const rootInstructions = readFileSync(path.join(repo, 'AGENTS.md'), 'utf8')
    expect(rootInstructions).toContain('docs/development/solver-development.md')
    expect(rootInstructions).toContain('app/slaves/cae/AGENTS.md')
    const caeInstructions = readFileSync(path.join(repo, 'app/slaves/cae/AGENTS.md'), 'utf8')
    for (const [, file] of caeInstructions.matchAll(/`([^`]+\.md)`/g))
      expect(existsSync(path.resolve(repo, 'app/slaves/cae', file)), file).toBe(true)
    expect(Buffer.byteLength(rootInstructions) + Buffer.byteLength(caeInstructions)).toBeLessThan(32 * 1024)
  })
})
