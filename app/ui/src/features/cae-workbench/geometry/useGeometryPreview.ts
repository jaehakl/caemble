import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CadCompilationError,
  CadDocumentEvaluationError,
  analyzeGeometrySource,
  createEffectiveGeometryGraph,
  evaluateGeometryModule,
  setGeometryAuthoringGraph,
  type CadDiagnostic,
  type CadScene,
  type EffectiveGeometryGraph,
  type GeometryDraftOverlay,
  type GeometryModuleCoordinate,
  type GeometrySnapshot,
} from '@/lib/cad'

const emptyGeometrySnapshot: GeometrySnapshot = { schemaVersion: 2, entryImports: [], modules: [] }

export function useGeometryPreview({
  currentSnapshot,
  entrySource,
  experimentAvailableOverlay,
  managerDraftOverlay,
  selectedCoordinate,
  selectedSource,
}: {
  currentSnapshot: GeometrySnapshot
  entrySource: string
  experimentAvailableOverlay: GeometryDraftOverlay
  managerDraftOverlay: GeometryDraftOverlay
  selectedCoordinate: GeometryModuleCoordinate | null
  selectedSource: string | undefined
}) {
  const [selectedExport, setSelectedExport] = useState<string | null>(null)
  const [effectiveGraph, setEffectiveGraph] = useState<EffectiveGeometryGraph | null>(null)
  const [graphError, setGraphError] = useState<string | null>(null)
  const [previewScene, setPreviewScene] = useState<CadScene | null>(null)
  const [previewSceneHash, setPreviewSceneHash] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewDiagnostics, setPreviewDiagnostics] = useState<readonly CadDiagnostic[]>([])
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewStale, setPreviewStale] = useState(false)
  const [previewedInputKey, setPreviewedInputKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setEffectiveGraph(null)
    setGeometryAuthoringGraph(null)
    const timeout = window.setTimeout(() => {
      void createEffectiveGeometryGraph(currentSnapshot, experimentAvailableOverlay, entrySource)
        .then((graph) => {
          if (cancelled) return
          setEffectiveGraph(graph)
          setGeometryAuthoringGraph(graph)
          setGraphError(null)
        })
        .catch((cause: unknown) => {
          if (cancelled) return
          setEffectiveGraph(null)
          setGeometryAuthoringGraph(null)
          setGraphError(cause instanceof Error ? cause.message : String(cause))
        })
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
      setGeometryAuthoringGraph(null)
    }
  }, [currentSnapshot, entrySource, experimentAvailableOverlay])

  const experimentDraftOverlay = useMemo<GeometryDraftOverlay>(() => {
    const reachable = new Set(effectiveGraph?.modules.map((module) => module.coordinate) ?? [])
    return Object.freeze(
      Object.fromEntries(
        Object.entries(experimentAvailableOverlay).filter(([coordinate]) =>
          reachable.has(coordinate as GeometryModuleCoordinate),
        ),
      ),
    )
  }, [effectiveGraph?.modules, experimentAvailableOverlay])

  const selectedAnalysis = useMemo(() => {
    if (!selectedCoordinate) return { exports: [] as readonly string[], error: null as string | null }
    if (!selectedSource) {
      return { exports: [] as readonly string[], error: '선택한 Geometry source를 불러오지 못했습니다.' }
    }
    try {
      const exports = analyzeGeometrySource(selectedSource, { allowLocal: true }).exports.map((item) => item.name)
      return { exports, error: exports.length ? null : 'Geometry source에 named export가 없습니다.' }
    } catch (cause) {
      return { exports: [] as readonly string[], error: cause instanceof Error ? cause.message : String(cause) }
    }
  }, [selectedCoordinate, selectedSource])
  const selectedExports = selectedAnalysis.exports

  useEffect(() => {
    if (!selectedExports.length) setSelectedExport(null)
    else if (!selectedExport || !selectedExports.includes(selectedExport)) setSelectedExport(selectedExports[0])
  }, [selectedExport, selectedExports])

  useEffect(() => {
    if (!selectedCoordinate || !selectedAnalysis.error) return
    setPreviewBusy(false)
    setPreviewError(selectedAnalysis.error)
    setPreviewDiagnostics([])
    setPreviewStale(true)
  }, [selectedAnalysis.error, selectedCoordinate])

  const previewInputKey = useMemo(
    () =>
      JSON.stringify({
        modules: Object.entries(managerDraftOverlay).sort(([left], [right]) => left.localeCompare(right)),
        selectedCoordinate,
        selectedExport,
      }),
    [managerDraftOverlay, selectedCoordinate, selectedExport],
  )

  useEffect(() => {
    if (!selectedCoordinate || !selectedExport || !selectedExports.includes(selectedExport)) return
    const abort = new AbortController()
    setPreviewBusy(true)
    setPreviewStale(true)
    void evaluateGeometryModule(emptyGeometrySnapshot, selectedCoordinate, selectedExport, {
      geometryDrafts: managerDraftOverlay,
      signal: abort.signal,
      timeoutMs: 10000,
    })
      .then((result) => {
        if (abort.signal.aborted) return
        setPreviewScene(result.scene)
        setPreviewSceneHash(result.sourceHash)
        setPreviewError(null)
        setPreviewDiagnostics([])
        setPreviewedInputKey(previewInputKey)
        setPreviewStale(false)
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted) return
        setPreviewError(cause instanceof Error ? cause.message : String(cause))
        setPreviewDiagnostics(
          cause instanceof CadCompilationError || cause instanceof CadDocumentEvaluationError ? cause.diagnostics : [],
        )
        setPreviewStale(true)
      })
      .finally(() => {
        if (!abort.signal.aborted) setPreviewBusy(false)
      })
    return () => abort.abort()
  }, [managerDraftOverlay, previewInputKey, selectedCoordinate, selectedExport, selectedExports])

  const resetPreview = useCallback(() => {
    setPreviewScene(null)
    setPreviewSceneHash(null)
    setPreviewError(null)
    setPreviewDiagnostics([])
    setPreviewBusy(false)
    setPreviewStale(false)
    setPreviewedInputKey(null)
  }, [])

  return {
    effectiveGraph,
    experimentDraftOverlay,
    graphError,
    previewBusy,
    previewDiagnostics,
    previewError,
    previewInputKey,
    previewScene,
    previewSceneHash,
    previewStale,
    previewedInputKey,
    resetPreview,
    selectedExport,
    selectedExports,
    setGraphError,
    setSelectedExport,
  }
}
