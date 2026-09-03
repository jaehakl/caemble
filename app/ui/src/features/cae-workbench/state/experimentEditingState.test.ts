import { describe, expect, it } from 'vitest'
import { createCadSourceDocument, type ExperimentSourceBundle } from '@/lib/cad/source'
import { defaultWorkbenchLayoutState, type SavedExperiment, type WorkbenchDraft } from '../types'
import {
  experimentEditingReducer,
  initialExperimentEditingState,
  type AgentExperimentChange,
} from './experimentEditingState'

function sourceBundle(source: string): ExperimentSourceBundle {
  return Object.freeze({ files: Object.freeze({ 'experiment.tsx': source }) })
}

function savedExperiment(id: number, source: ExperimentSourceBundle, name = `Experiment ${id}`): SavedExperiment {
  return {
    id,
    namespace: 'user',
    repository_slug: 'workspace',
    experiment_key: `experiment-${id}`,
    version_major: 1,
    version_minor: 0,
    version_patch: 0,
    name,
    description: `${name} description`,
    source_bundle: source,
    source_hash: `hash-${id}`,
  }
}

const materialParameters = Object.freeze({
  experiment: Object.freeze({ materials: Object.freeze({}) }),
  tasks: Object.freeze({}),
})

const agentChange: AgentExperimentChange = Object.freeze({
  runId: 'run-1',
  appliedAt: 1,
  status: 'applied',
  files: Object.freeze([
    Object.freeze({
      path: 'experiment.tsx',
      before: 'before',
      after: 'after',
      addedLines: 1,
      removedLines: 1,
    }),
  ]),
})

describe('experimentEditingReducer', () => {
  it('loads a server record as one clean snapshot', () => {
    const bundle = sourceBundle('saved source')
    const document = createCadSourceDocument('experiment', bundle)
    const record = savedExperiment(7, bundle)
    const dirtyState = experimentEditingReducer(initialExperimentEditingState, {
      type: 'candidateLoaded',
      vars: { width: 3 },
      materialParameters,
    })

    const loaded = experimentEditingReducer(dirtyState, { type: 'recordLoaded', document, record })

    expect(loaded).toMatchObject({
      document,
      record,
      baselineBundle: bundle,
      name: record.name,
      description: record.description,
      candidateVars: null,
      candidateMaterialParameters: null,
      workspaceSession: 1,
      agentChange: null,
      agentWorkspaceIdentity: null,
    })
  })

  it('keeps the loaded baseline while source and Agent edits replace only the draft document', () => {
    const savedBundle = sourceBundle('saved source')
    const savedDocument = createCadSourceDocument('experiment', savedBundle)
    const record = savedExperiment(7, savedBundle)
    const loaded = experimentEditingReducer(initialExperimentEditingState, {
      type: 'recordLoaded',
      document: savedDocument,
      record,
    })
    const withCandidate = experimentEditingReducer(loaded, {
      type: 'candidateLoaded',
      vars: { width: 4 },
      materialParameters,
    })
    const withIdentity = experimentEditingReducer(withCandidate, {
      type: 'agentWorkspaceIdentityChanged',
      identity: { baseHash: 'saved-hash', document: savedDocument },
    })
    const editedDocument = createCadSourceDocument('experiment', sourceBundle('manual edit'))

    const edited = experimentEditingReducer(withIdentity, { type: 'sourceEdited', document: editedDocument })

    expect(edited.document).toBe(editedDocument)
    expect(edited.record).toBe(record)
    expect(edited.baselineBundle).toBe(savedBundle)
    expect(edited.candidateVars).toEqual({ width: 4 })
    expect(edited.candidateMaterialParameters).toBeNull()
    expect(edited.agentWorkspaceIdentity).toBeNull()

    const agentDocument = createCadSourceDocument('experiment', sourceBundle('agent edit'))
    const applied = experimentEditingReducer(edited, {
      type: 'agentApplied',
      document: agentDocument,
      change: agentChange,
    })
    expect(applied.document).toBe(agentDocument)
    expect(applied.baselineBundle).toBe(savedBundle)
    expect(applied.agentChange).toBe(agentChange)
  })

  it('commits save metadata without replacing a newer local document', () => {
    const originalBundle = sourceBundle('original')
    const localDocument = createCadSourceDocument('experiment', sourceBundle('local source'))
    const original = savedExperiment(3, originalBundle)
    const loaded = experimentEditingReducer(initialExperimentEditingState, {
      type: 'recordLoaded',
      document: createCadSourceDocument('experiment', originalBundle),
      record: original,
    })
    const edited = experimentEditingReducer(loaded, { type: 'sourceEdited', document: localDocument })
    const committedRecord = savedExperiment(3, localDocument.sourceBundle, 'Committed')

    const committed = experimentEditingReducer(edited, {
      type: 'saveCommitted',
      record: committedRecord,
      baselineBundle: localDocument.sourceBundle,
    })

    expect(committed.document).toBe(localDocument)
    expect(committed.record).toBe(committedRecord)
    expect(committed.baselineBundle).toBe(localDocument.sourceBundle)
    expect(committed.name).toBe('Committed')
  })

  it('restores local drafts and starts or detaches snapshots atomically', () => {
    const bundle = sourceBundle('draft source')
    const document = createCadSourceDocument('experiment', bundle)
    const record = savedExperiment(9, bundle)
    const draft: WorkbenchDraft = {
      savedAt: 10,
      experiment: {
        record,
        baselineBundle: bundle,
        document,
        name: 'Local Draft',
        description: 'restored locally',
      },
      candidate: { vars: { width: 8 }, materialParameters },
      selection: { experimentId: 9, measurementId: 12, calculationId: 7 },
      layout: defaultWorkbenchLayoutState,
    }

    const restored = experimentEditingReducer(initialExperimentEditingState, {
      type: 'draftRestored',
      draft,
      document,
      candidateMaterialParameters: materialParameters,
    })
    expect(restored).toMatchObject({
      document,
      record,
      baselineBundle: bundle,
      name: 'Local Draft',
      candidateVars: { width: 8 },
      candidateMaterialParameters: materialParameters,
      workspaceSession: 1,
    })

    const newBundle = sourceBundle('new source')
    const newDocument = createCadSourceDocument('experiment', newBundle)
    const started = experimentEditingReducer(restored, {
      type: 'newStarted',
      document: newDocument,
      sourceBundle: newBundle,
      name: 'New Experiment',
      description: '',
    })
    expect(started).toMatchObject({
      document: newDocument,
      record: null,
      baselineBundle: newBundle,
      name: 'New Experiment',
      candidateVars: null,
      candidateMaterialParameters: null,
      workspaceSession: 2,
    })

    const detachedDocument = createCadSourceDocument('experiment', newBundle)
    const detached = experimentEditingReducer(started, { type: 'detached', document: detachedDocument })
    expect(detached).toMatchObject({
      document: detachedDocument,
      record: null,
      baselineBundle: null,
      name: 'New Experiment',
      workspaceSession: 3,
    })
  })

  it('does not clear a frozen material snapshot when evaluation echoes only variables', () => {
    const withCandidate = experimentEditingReducer(initialExperimentEditingState, {
      type: 'candidateLoaded',
      vars: { width: 1 },
      materialParameters,
    })

    const variablesOnly = experimentEditingReducer(withCandidate, {
      type: 'candidateEvaluationAccepted',
      vars: { width: 2 },
    })
    expect(variablesOnly.candidateVars).toEqual({ width: 2 })
    expect(variablesOnly.candidateMaterialParameters).toBe(materialParameters)

    const nextMaterials = Object.freeze({
      experiment: Object.freeze({ materials: Object.freeze({ steel: Object.freeze({}) }) }),
      tasks: Object.freeze({}),
    })
    const echoed = experimentEditingReducer(variablesOnly, {
      type: 'candidateEvaluationAccepted',
      vars: { width: 2 },
      materialParameters: nextMaterials,
    })
    expect(echoed.candidateMaterialParameters).toBe(nextMaterials)
  })
})
