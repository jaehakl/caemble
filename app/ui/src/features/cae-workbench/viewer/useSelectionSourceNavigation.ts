import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { CadEditorRevealRequest } from '@/features/viewer/editor/CadEditor'
import {
  findCadSourcePathLocationsByValue,
  type CadSourcePathLocation,
} from '@/features/viewer/editor/cadSelectionSource'
import type { CadViewerSelectionQuery, CadViewerSourceLookupStatus } from '@/features/viewer/viewer/selection'
import type { WorkbenchLayoutState, WorkbenchSectionId } from '../types'

type SelectionSourceLookup = Readonly<{
  files: Readonly<Record<string, string>> | null
  locations: ReadonlyMap<string, readonly CadSourcePathLocation[]>
  pathKey: string
}>

type SelectionSourceNavigationOptions = Readonly<{
  activeSection: WorkbenchSectionId
  calculationDirty: boolean
  files: Readonly<Record<string, string>> | null
  guardReplacement: (run: () => unknown | Promise<unknown>, cancel?: () => void) => void
  setLayout: Dispatch<SetStateAction<WorkbenchLayoutState>>
  workspaceSession: number
}>

export function useSelectionSourceNavigation({
  activeSection,
  calculationDirty,
  files,
  guardReplacement,
  setLayout,
  workspaceSession,
}: SelectionSourceNavigationOptions) {
  const [selectionQuery, setSelectionQuery] = useState<CadViewerSelectionQuery | null>(null)
  const [sourceRevealRequest, setSourceRevealRequest] = useState<
    (CadEditorRevealRequest & Readonly<{ path: string }>) | null
  >(null)
  const [sourcePathPicker, setSourcePathPicker] = useState<Readonly<{
    locations: readonly CadSourcePathLocation[]
    value: string
  }> | null>(null)
  const [sourcePaths, setSourcePaths] = useState<readonly string[]>([])
  const [lookup, setLookup] = useState<SelectionSourceLookup>({ files: null, locations: new Map(), pathKey: '' })
  const revealSequence = useRef(0)
  const pathKey = sourcePaths.join('\u0000')

  const selectionSourceStatus = useMemo(() => {
    const ready = lookup.files === files && lookup.pathKey === pathKey
    const status: Record<string, CadViewerSourceLookupStatus> = {}
    sourcePaths.forEach((value) => {
      status[value] = ready ? (lookup.locations.get(value)?.length ? 'available' : 'missing') : 'checking'
    })
    return status
  }, [files, lookup, pathKey, sourcePaths])

  const revealSourceLocation = useCallback(
    (location: CadSourcePathLocation) => {
      const reveal = () => {
        setSourcePathPicker(null)
        setSourceRevealRequest({
          end: location.end,
          id: ++revealSequence.current,
          path: location.path,
          start: location.start,
        })
        setLayout((current) => ({
          ...current,
          activeExperimentFile: location.path,
          activeSection: 'experiment',
          rightTabs: { ...current.rightTabs, experiment: 'source' },
          viewerExpanded: false,
        }))
      }
      if (activeSection === 'measurement' && calculationDirty) guardReplacement(reveal)
      else reveal()
    },
    [activeSection, calculationDirty, guardReplacement, setLayout],
  )

  const findSelectionSource = useCallback(
    (value: string) => {
      if (lookup.files !== files || lookup.pathKey !== pathKey) return
      const locations = lookup.locations.get(value) ?? []
      if (locations.length === 1) revealSourceLocation(locations[0])
      else if (locations.length > 1) setSourcePathPicker({ locations, value })
    },
    [files, lookup, pathKey, revealSourceLocation],
  )

  const handleSelectionSourcePathsChange = useCallback((values: readonly string[]) => {
    setSourcePaths((current) =>
      current.length === values.length && current.every((value, index) => value === values[index])
        ? current
        : [...values],
    )
  }, [])

  const handleCodeSelectionQueryChange = useCallback((query: CadViewerSelectionQuery | null) => {
    setSelectionQuery((current) => query ?? (current?.origin === 'code' ? null : current))
  }, [])

  const handleSourceRevealRequestHandled = useCallback((id: number) => {
    setSourceRevealRequest((current) => (current?.id === id ? null : current))
  }, [])

  useEffect(() => {
    setSelectionQuery(null)
    setSourcePathPicker(null)
    setSourceRevealRequest(null)
    setSourcePaths([])
    setLookup({ files: null, locations: new Map(), pathKey: '' })
  }, [workspaceSession])

  useEffect(() => {
    let cancelled = false
    const timeout = window.setTimeout(() => {
      const locations = files
        ? findCadSourcePathLocationsByValue(files, sourcePaths)
        : new Map(sourcePaths.map((value) => [value, []] as const))
      if (!cancelled) setLookup({ files, locations, pathKey })
    }, 0)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [files, pathKey, sourcePaths])

  return {
    closeSourcePathPicker: () => setSourcePathPicker(null),
    findSelectionSource,
    handleCodeSelectionQueryChange,
    handleSelectionSourcePathsChange,
    handleSourceRevealRequestHandled,
    handleViewerSelectionQueryChange: setSelectionQuery,
    revealSourceLocation,
    selectionQuery,
    selectionSourceStatus,
    sourcePathPicker,
    sourceRevealRequest,
  }
}
