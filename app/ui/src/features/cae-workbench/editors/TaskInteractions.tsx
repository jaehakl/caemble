import { Link } from 'react-router'
import type { MeasurementMaterialSnapshot } from '@/contracts/api/measurement'

export function TaskInteractions({
  task,
  snapshot,
  onOpenSource,
}: {
  task: string
  snapshot: MeasurementMaterialSnapshot
  onOpenSource: () => void
}) {
  const roles = Object.entries(snapshot.interactionSelections?.[task] ?? {})
  if (!roles.length) return null
  return (
    <details className="shrink-0 border-b bg-muted/20 px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium">Material Interactions · {task}</summary>
      <div className="mt-2 max-h-48 space-y-2 overflow-auto">
        {roles.flatMap(([role, bindings]) =>
          bindings.map((binding) => (
            <div className="rounded border bg-background p-2" key={JSON.stringify([role, binding.between])}>
              <p>
                {binding.between.join(' ↔ ')} · {role} · {binding.interaction ?? '기본 접촉'}
              </p>
              {Object.entries(binding.models).map(([group, instance]) => {
                const model =
                  instance && binding.interaction ? snapshot.interactions?.[binding.interaction].models[instance] : null
                return (
                  <p className="mt-1 text-muted-foreground" key={group}>
                    {group}:{' '}
                    {model ? (
                      <Link className="text-primary" to={`/doc?help=materials&item=${encodeURIComponent(model.model)}`}>
                        {instance} · {model.model}
                      </Link>
                    ) : (
                      'Solver 기본값'
                    )}
                  </p>
                )
              })}
            </div>
          )),
        )}
        <button className="font-medium text-primary underline" type="button" onClick={onOpenSource}>
          material.tsx 열기
        </button>
      </div>
    </details>
  )
}
