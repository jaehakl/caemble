import { useEffect, useRef } from 'react'
import { emitRuntimeActivity, type RuntimeActivityCallback } from '@/features/runtime-console/types'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'

export function useExperimentWarnings(document: CadDocumentController, onActivity: RuntimeActivityCallback) {
  const reported = useRef(new Set<string>())
  const scope = useRef('')

  useEffect(() => {
    if (document.runIsBusy || document.successfulRevision !== document.revision) return
    const nextScope = JSON.stringify([
      document.resultSessionKey,
      document.revision,
      document.completedCandidateGeneration,
    ])
    if (scope.current !== nextScope) {
      scope.current = nextScope
      reported.current.clear()
    }
    const warnings = document.materialWarnings.map((message) => ({ phase: 'materials.warning', message }))
    if (document.draftTaskNames.length) {
      warnings.push({
        phase: 'solver.unselected',
        message: `Solver 미선택 · Task: ${document.draftTaskNames.join(', ')} · 형상 미리보기와 Experiment 저장은 가능하지만 Measurement 저장과 CAE 실행은 사용할 수 없습니다.`,
      })
    }
    for (const warning of warnings) {
      const key = JSON.stringify(warning)
      if (reported.current.has(key)) continue
      reported.current.add(key)
      emitRuntimeActivity(onActivity, { source: 'cad', level: 'warning', ...warning })
    }
  }, [document, onActivity])
}
