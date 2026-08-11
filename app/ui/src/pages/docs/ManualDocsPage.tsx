import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { DocsSectionId } from './docsRoute'
import { manualDocsKnowledge, type DocsKnowledgeChunk } from './docsKnowledge'

const manualSectionTitles = {
  workbench: ['Workbench Quickstart', '처음 실행부터 결과 확인까지'],
  structure: ['Structure Authoring', '형상, 변수, Material과 안정적인 solver target 작성'],
  program: ['Experiment Program', 'named task와 Python orchestration으로 계산 과정 구성'],
  reference: ['API / CAD Reference', '공개 source, DataSchema와 실행 경계'],
  troubleshooting: ['Troubleshooting', '오류가 발생한 단계에서 원인을 빠르게 좁히기'],
} as const

export function ManualDocsPage({
  section,
}: {
  section: Extract<DocsSectionId, 'workbench' | 'structure' | 'program' | 'reference' | 'troubleshooting'>
}) {
  const [title, description] = manualSectionTitles[section]
  const chunks = manualDocsKnowledge.filter((chunk) => chunk.section === section)

  return (
    <section className="bg-white">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-11">
        <header className="border-b pb-7">
          <p className="text-xs font-semibold tracking-[0.16em] text-orange-700 uppercase">Manual</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">{title}</h1>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600 sm:text-base">{description}</p>
        </header>

        <div className="mt-8 space-y-8">
          {chunks.map((chunk) =>
            chunk.collapsed ? (
              <details
                className="scroll-mt-24 overflow-hidden rounded-xl border bg-slate-50"
                id={chunk.anchor}
                key={chunk.id}
              >
                <summary className="cursor-pointer px-5 py-4 marker:text-orange-700">
                  <span className="ml-2 font-semibold text-slate-950">{chunk.title}</span>
                  <span className="mt-1 ml-5 block text-sm font-normal text-slate-600">{chunk.summary}</span>
                </summary>
                {chunk.aliases?.map((alias) => (
                  <span className="block scroll-mt-24" id={alias} key={alias} />
                ))}
                <div className="border-t bg-white px-5 py-5 sm:px-6">
                  <MarkdownContent chunk={chunk} />
                </div>
              </details>
            ) : (
              <article className="scroll-mt-24" id={chunk.anchor} key={chunk.id}>
                {chunk.aliases?.map((alias) => (
                  <span className="block scroll-mt-24" id={alias} key={alias} />
                ))}
                <h2 className="text-xl font-semibold tracking-tight text-slate-950">{chunk.title}</h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">{chunk.summary}</p>
                <div className="mt-4 rounded-xl border bg-white px-5 py-5 shadow-sm sm:px-6">
                  <MarkdownContent chunk={chunk} />
                </div>
              </article>
            ),
          )}
        </div>
      </div>
    </section>
  )
}

function MarkdownContent({ chunk }: { chunk: DocsKnowledgeChunk }) {
  return (
    <div className="space-y-4 text-sm leading-7 text-slate-700 [&_a]:font-medium [&_a]:text-orange-700 [&_a]:underline [&_a]:underline-offset-4 [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.88em] [&_h3]:mt-6 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-slate-950 [&_li]:my-1 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_p]:my-3 [&_pre]:my-4 [&_pre]:max-h-[560px] [&_pre]:overflow-auto [&_pre]:rounded-xl [&_pre]:bg-slate-950 [&_pre]:p-4 [&_pre]:text-xs [&_pre]:leading-5 [&_pre]:text-slate-100 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:bg-slate-50 [&_th]:px-3 [&_th]:py-2 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{chunk.content}</ReactMarkdown>
    </div>
  )
}
