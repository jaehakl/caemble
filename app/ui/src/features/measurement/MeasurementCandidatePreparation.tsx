import { useEffect } from 'react'
import type { ExperimentSourceDocument } from '@/lib/cad/source'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { useCadWorkspace, type CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import type { ReviewedMeasurementInput } from './useCaeMeasurementActions'

export type MeasurementCandidatePreparationRequest = {
  input: ReviewedMeasurementInput
  resolve: (document: CadDocumentController) => void
  reject: (cause: unknown) => void
}

/** Evaluate off screen so a pending candidate cannot replace either displayed scene. */
export function MeasurementCandidatePreparation({
  request,
  experiment,
  onActivity,
}: {
  request: MeasurementCandidatePreparationRequest
  experiment: ExperimentSourceDocument | null
  onActivity?: RuntimeActivityCallback
}) {
  const { experimentDocument } = useCadWorkspace(experiment, undefined, {
    candidateVars: request.input.vars,
    candidateProvenance: request.input.measurementId ? 'persisted-measurement' : 'editable',
    persistedMaterialSnapshot: request.input.materialSnapshot,
    onActivity,
  })
  useEffect(() => {
    if (experimentDocument.error) {
      request.reject(new Error(experimentDocument.error.message))
    } else if (
      experimentDocument.status === 'Ready' &&
      experimentDocument.successfulRevision === experimentDocument.revision &&
      experimentDocument.materialSnapshot
    ) {
      // Display snapshots outlive this evaluator; rendering must not update its lifecycle.
      request.resolve({
        ...experimentDocument,
        handleRenderStart: () => {},
        handleRenderEnd: () => {},
        handleRenderError: () => {},
      })
    }
  }, [experimentDocument, request])
  return null
}
