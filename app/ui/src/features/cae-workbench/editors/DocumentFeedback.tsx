import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'

export function DocumentFeedback({ controller }: { controller: CadDocumentController }) {
  if (controller.error) {
    return (
      <footer className="max-h-32 shrink-0 overflow-auto border-t border-rose-200 bg-rose-50 px-4 py-2.5" role="alert">
        <div className="text-xs font-semibold text-rose-800">{controller.error.title}</div>
        <pre className="mt-1 text-xs leading-5 whitespace-pre-wrap text-rose-700">
          {controller.error.message}
          {controller.error.stack ? `\n\n${controller.error.stack}` : ''}
        </pre>
      </footer>
    )
  }

  if (controller.materialWarnings.length > 0) {
    return (
      <footer className="max-h-24 shrink-0 overflow-auto border-t border-amber-200 bg-amber-50 px-4 py-2.5">
        <div className="text-xs font-semibold text-amber-900">Material warning</div>
        <p className="mt-1 text-xs leading-5 text-amber-800">{controller.materialWarnings[0]}</p>
      </footer>
    )
  }

  const errorCount = controller.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length
  const warningCount = controller.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length

  return (
    <footer className="flex min-h-9 shrink-0 items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
      <span>
        {errorCount > 0 || warningCount > 0 ? `${errorCount} errors · ${warningCount} warnings` : 'No diagnostics'}
      </span>
      <span>{controller.status}</span>
    </footer>
  )
}
