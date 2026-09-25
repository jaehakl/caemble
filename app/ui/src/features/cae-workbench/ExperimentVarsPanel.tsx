import { useLayoutEffect, useMemo, useState } from 'react'
import { VarsEditor } from '@/components/vars-editor'
import { flattenVarsTensor } from '@/lib/cad/model'
import type { CaeWorkbenchState } from './state/useCaeWorkbenchState'

export function ExperimentVarsPanel({ workbench, previewing }: { workbench: CaeWorkbenchState; previewing: boolean }) {
  const { experimentDocument: document, candidateVars, selectionRestoring, experimentSourceValidated } = workbench
  const [validatedSource, setValidatedSource] = useState<{
    source: CaeWorkbenchState['experiment']
    session: number
  } | null>(null)
  const source = workbench.experiment
  const session = workbench.workspaceSession
  useLayoutEffect(() => {
    if (experimentSourceValidated) setValidatedSource({ source, session })
  }, [experimentSourceValidated, source, session])
  // CAD revisions also advance for vars-only evaluations. Keep this source editable during those evaluations.
  const sourceValidated =
    experimentSourceValidated || (validatedSource?.source === source && validatedSource?.session === session)
  const schema = document.varsSchema
  const value = candidateVars ?? document.variables
  const ready = useMemo(() => {
    if (!schema || !value) return false
    try {
      return (
        Object.keys(schema).length === Object.keys(value).length &&
        Object.entries(schema).every(([key, entry]) =>
          flattenVarsTensor(value[key], entry.shape, key).every(
            (member) => Number.isFinite(member) && member >= entry.min && member <= entry.max,
          ),
        )
      )
    } catch {
      return false
    }
  }, [schema, value])
  const message = previewing
    ? '미리보기 중에는 vars를 편집할 수 없습니다.'
    : selectionRestoring
      ? 'Measurement를 불러오는 중입니다.'
      : !sourceValidated
        ? 'Experiment 소스 검증이 필요합니다.'
        : !ready || document.resultSessionKey !== workbench.workspaceSession
          ? 'vars를 준비하는 중입니다.'
          : null
  return (
    <div className="space-y-3 p-3">
      <p className="text-[11px] text-muted-foreground">
        막대를 누른 채 위아래로 이동하면 여러 값을 조절할 수 있습니다.
      </p>
      {message ? (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
      {ready && schema && value ? (
        <VarsEditor
          schema={schema}
          value={value}
          disabled={message !== null}
          resetKey={session}
          onValueChange={(next) => workbench.setCandidateVariables(next, 'user-vars')}
        />
      ) : null}
    </div>
  )
}
