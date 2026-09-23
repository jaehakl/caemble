import type { RecordedResultContracts } from '@/contracts/results'
import type { ViewerDefaults } from '@/contracts/viewerDefaults'

export type GeometryMode = 0 | 0.5 | 0.9
export type VisualizationSelection = Record<string, string>

export function initialViewerDisplay(defaults?: ViewerDefaults | null) {
  if (defaults?.version === 2)
    return { geometry: defaults.geometryMode, output: defaults.selectedOutput, visualizations: defaults.visualizations }
  const name = defaults?.selectedResult ?? ''
  const settings = defaults?.settings ?? {}
  const opacity = settings[`${name}:box.geometryOpacity`]
  const off =
    settings['@workspace:experimentVisible'] === false ||
    settings[`${name}:box.overlay`] === false ||
    settings[`${name}:particles.geometry`] === false
  return {
    geometry: (off ? 0 : typeof opacity === 'number' && opacity < 0.7 ? 0.5 : 0.9) as GeometryMode,
    output: name.startsWith('@visualizations.') ? '' : name,
    visualizations: {} as VisualizationSelection,
  }
}

export function visualizationGroups(contracts: RecordedResultContracts) {
  const groups: Record<string, string[]> = {}
  for (const [name, contract] of Object.entries(contracts)) {
    if (!name.startsWith('@visualizations.')) continue
    const kind = contract.visualization.kind
    ;(groups[kind] ??= []).push(name)
  }
  return groups
}

export function initializeVisualizations(
  contracts: RecordedResultContracts,
  current: VisualizationSelection,
  defaults?: ViewerDefaults | null,
) {
  const next = { ...current }
  for (const [kind, names] of Object.entries(visualizationGroups(contracts))) {
    if (Object.prototype.hasOwnProperty.call(next, kind)) continue
    const legacy = defaults?.version === 1 ? defaults.selectedResult : undefined
    const overlays = legacy === undefined ? [] : defaults?.settings[`${legacy}:overlay`]
    next[kind] =
      (legacy && names.includes(legacy) ? legacy : undefined) ??
      (kind === 'polyline' && Array.isArray(overlays) ? names.find((name) => overlays.includes(name)) : undefined) ??
      (defaults ? '' : names[0])
  }
  return next
}

export function sameInvocation(a: unknown, b: unknown) {
  if (!a || !b) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const solverA = left.solver as { name?: string; version?: string } | undefined
  const solverB = right.solver as { name?: string; version?: string } | undefined
  return (
    ['task', 'stateRevision', 'invocation', 'catalogRevision'].every((key) => left[key] === right[key]) &&
    solverA?.name === solverB?.name &&
    solverA?.version === solverB?.version
  )
}
