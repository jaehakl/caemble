import type { StructureSourceDocument } from '@/lib/cad'
import CadEditor from '@/features/viewer/editor/CadEditor'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import { DocumentFeedback } from './DocumentFeedback'

export type StructureEditorProps = {
  controller: CadDocumentController
  disabled?: boolean
  document: StructureSourceDocument | null
}

export function StructureEditor({ controller, disabled = false, document }: StructureEditorProps) {
  if (!document) {
    return (
      <section
        aria-label="Structure editor"
        className="grid h-full min-h-0 place-items-center bg-slate-50 p-8 text-center"
      >
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Structure가 열려 있지 않습니다</h2>
          <p className="mt-1 text-sm text-slate-500">
            Source 메뉴에서 새 Structure를 만들거나 저장된 항목을 불러오세요.
          </p>
        </div>
      </section>
    )
  }

  return (
    <section aria-label="Structure editor" className="flex h-full min-h-0 min-w-0 flex-col bg-white">
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-slate-200 bg-slate-50 px-4">
        <span className="font-mono text-xs font-semibold text-slate-700">structure.tsx</span>
        <span className="text-xs text-slate-500">
          {controller.sourceReadOnly || disabled ? 'Read only' : 'Editable'}
        </span>
      </header>
      <div className="min-h-0 flex-1">
        <CadEditor
          diagnostics={controller.diagnostics.filter((diagnostic) => diagnostic.file === 'structure.tsx')}
          modelPath="file:///structure.tsx"
          readOnly={controller.sourceReadOnly || disabled}
          value={document.source}
          onChange={controller.handleSourceChange}
        />
      </div>
      <DocumentFeedback controller={controller} />
    </section>
  )
}
