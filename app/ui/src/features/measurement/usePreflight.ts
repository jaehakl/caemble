import { useEffect, useRef, useState } from 'react'
import { browserClient } from '@/api/http'
import { caeBatches } from '@/api/cae'
import { resolveObjects } from '@/api/objectStorage'
import { sha256Bytes, submitArtifact } from '@/api/submitArtifact'
import { BUILD_VERSION, type BuildArtifact } from '@/contracts/build'
import type { RecordedResultContracts } from '@/contracts/results'
import { fetchCatalogRuntimeSlice } from '@/features/viewer/workspace/catalogRuntime'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import { cadSourceHash, type ExperimentSourceDocument } from '@/lib/cad/source'
import type { RecordedData } from '@/lib/cad/model'
import { isDataTensor } from '@/lib/cad/model/dataTensor'
import type { RecordedDataSchemaTree } from '@/lib/cad/simulation'
import { flattenRecordedData, recordedDataRules } from '@/lib/cad/simulation/recordedData'
import { materialVarsHash } from '@/lib/material/resolution'

type PreflightResult = Readonly<{
  id: string
  execution_mode: 'brief' | 'full'
  expires_at: string
  source_hash: string
  vars_hash: string
  result_contracts: RecordedResultContracts
  schemas: RecordedDataSchemaTree
  recorded_data: RecordedData
}>

export function usePreflight(
  experiment: ExperimentSourceDocument | null,
  document: CadDocumentController,
  selectionKey: unknown,
) {
  const [mode, setMode] = useState<'brief' | 'full'>('brief')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<null | {
    payload: PreflightResult
    document: CadDocumentController
    experiment: ExperimentSourceDocument
    data: RecordedData
    rules: ReturnType<typeof recordedDataRules>
    errors: Record<string, string>
  }>(null)
  const active = useRef<{ controller: AbortController; batchId?: string } | null>(null)
  const pending = useRef<{ generation: number; sourceBundle: ExperimentSourceDocument['sourceBundle'] } | null>(null)
  const [viewerEpoch, setViewerEpoch] = useState(0)

  useEffect(() => {
    setResult(null)
    setBusy(false)
    setStatus('')
    setError(null)
    pending.current = null
    return () => {
      const run = active.current
      active.current = null
      pending.current = null
      run?.controller.abort()
      if (run?.batchId) void caeBatches.cancel(run.batchId).catch(() => undefined)
    }
  }, [selectionKey])

  const run = async (regenerate = false) => {
    if (active.current || pending.current) return
    if (regenerate) {
      if (!experiment) return
      const generation = document.generateCandidate?.()
      if (generation == null) {
        setError('Candidate 생성을 시작하지 못했습니다.')
        return
      }
      pending.current = { generation, sourceBundle: experiment.sourceBundle }
      setBusy(true)
      setError(null)
      setStatus('Candidate 준비 중')
      return
    }
    if (!experiment || !document.variables || !document.measurement || !document.evaluatedSnapshot || active.current)
      return
    const execution = { controller: new AbortController(), batchId: undefined as string | undefined }
    active.current = execution
    const signal = execution.controller.signal
    setBusy(true)
    setError(null)
    setStatus('입력 준비 중')
    try {
      const sourceHash = await cadSourceHash(experiment)
      if (
        document.evaluatedSnapshot.sourceHash !== sourceHash ||
        document.successfulRevision !== document.revision ||
        materialVarsHash(document.variables) !== materialVarsHash(document.evaluatedSnapshot.variables)
      )
        throw new Error('현재 소스의 Geometry와 Vars 준비가 끝난 뒤 실행하세요.')
      const catalog = await fetchCatalogRuntimeSlice(experiment.sourceBundle)
      // The evaluated Candidate already owns the exact canonical scene and
      // Material snapshot displayed by this document. Do not evaluate it again.
      const input = { measurement: document.measurement }
      const bytes = new TextEncoder().encode(JSON.stringify(input))
      const artifact: BuildArtifact = {
        kind: 'caemble.build',
        version: 2,
        builder_version: BUILD_VERSION,
        source_hash: sourceHash,
        source_bundle: experiment.sourceBundle,
        catalog_revision: catalog.catalogRevision,
        mode: 'candidate',
        items: [{ index: 1, file: 'items/1.json', input_hash: await sha256Bytes(bytes), byte_length: bytes.length }],
      }
      let batch = await submitArtifact({
        client: browserClient,
        artifact,
        experimentId: null,
        preflightMode: mode,
        requestId: crypto.randomUUID(),
        readItem: async () => bytes,
        signal,
        onRegistered: (id) => {
          execution.batchId = id
        },
      })
      while (!['completed', 'cancelled'].includes(batch.state)) {
        setStatus(batch.state === 'running' ? '계산 중' : 'Launcher 대기 중')
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer)
            reject(new DOMException('Cancelled', 'AbortError'))
          }
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort)
            resolve()
          }, 1000)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })
        batch = await caeBatches.read(batch.id, {}, { signal })
      }
      if (batch.succeeded !== 1) throw new Error(batch.jobs[0]?.last_error ?? '실행이 취소되었습니다.')
      setStatus('결과 불러오는 중')
      const payload = await browserClient.request<PreflightResult>(
        'get',
        `/cae/preflights/${batch.id}/result`,
        undefined,
        { signal },
      )
      const data: Record<string, RecordedData[string]> = {}
      const errors: Record<string, string> = {}
      const names = Object.keys(payload.result_contracts)
      for (const name of names) {
        try {
          const value = payload.recorded_data?.[name]
          if (value === undefined || value === null) throw new Error('응답에 선언된 결과 데이터가 없습니다.')
          if (!payload.schemas[name]) throw new Error('응답에 결과 schema가 없습니다.')
          const resolved = await resolveObjects(browserClient, value, signal)
          const flat = flattenRecordedData({ [name]: payload.schemas[name] }, { [name]: resolved })
          if (!flat || !Object.keys(flat).length || !Object.values(flat).every(isDataTensor))
            throw new Error('응답에 필요한 tensor 데이터가 없습니다.')
          Object.assign(data, flat)
        } catch (cause) {
          signal.throwIfAborted()
          errors[name] = cause instanceof Error ? cause.message : String(cause)
        }
      }
      signal.throwIfAborted()
      if (active.current !== execution) return
      setResult({
        payload,
        experiment,
        document,
        errors,
        data,
        rules: recordedDataRules(payload.schemas, 'preflight.recorded-data'),
      })
      const failures = Object.keys(errors).length
      setStatus(
        failures
          ? failures === names.length
            ? '결과 불러오기 실패'
            : '일부 결과 불러오기 실패'
          : '완료 · 임시 결과 24시간 보관',
      )
    } catch (cause) {
      if (active.current === execution) {
        setError(signal.aborted ? null : cause instanceof Error ? cause.message : String(cause))
        setStatus(signal.aborted ? '취소됨' : '실행 실패')
      }
      if (execution.batchId) await caeBatches.cancel(execution.batchId).catch(() => undefined)
    } finally {
      if (active.current === execution) {
        active.current = null
        setBusy(false)
      }
    }
  }
  const runRef = useRef(run)
  runRef.current = run
  useEffect(() => {
    const request = pending.current
    if (!request) return
    if (experiment?.sourceBundle !== request.sourceBundle || document.candidateGeneration > request.generation) {
      pending.current = null
      setBusy(false)
      setStatus('취소됨')
    } else if (document.completedCandidateGeneration === request.generation) {
      pending.current = null
      if (document.successfulCandidateGeneration === request.generation && document.successfulRevision === document.revision && document.variables && document.measurement && document.evaluatedSnapshot) {
        void runRef.current()
      } else {
        setBusy(false)
        setStatus('Candidate 준비 실패')
        setError('Candidate 평가·빌드에 실패했습니다. 진단을 확인하세요.')
      }
    }
  }, [document, experiment])
  const cancel = async () => {
    if (pending.current) {
      pending.current = null
      setBusy(false)
      setStatus('취소됨')
    }
    const execution = active.current
    execution?.controller.abort()
    if (execution?.batchId) {
      try {
        await caeBatches.cancel(execution.batchId)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
  }
  return {
    mode,
    setMode,
    busy,
    status,
    error,
    result,
    viewerEpoch,
    run,
    cancel,
    clear: () => {
      setResult(null)
      setStatus('')
      setViewerEpoch((value) => value + 1)
    },
  }
}
