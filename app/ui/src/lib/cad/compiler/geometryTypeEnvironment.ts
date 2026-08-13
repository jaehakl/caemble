import type * as Monaco from 'monaco-editor'
import { geometryCoordinateTypes, geometryRootTypes, type GeometryTypeGraph } from './geometryTypes'

const emptyGraph: GeometryTypeGraph = Object.freeze({ roots: Object.freeze([]), modules: Object.freeze([]) })
const rootTypesPath = 'file:///geometry-roots.d.ts'
const coordinateTypesPath = 'file:///geometry-coordinates.d.ts'

let environmentMonaco: typeof Monaco | null = null
let environmentKey = ''
let environmentDisposables: Monaco.IDisposable[] = []
let authoringGraph: GeometryTypeGraph | null = null
let authoringRootsEnabled = false
let environmentQueue = Promise.resolve()

function graphKey(graph: GeometryTypeGraph) {
  return JSON.stringify({
    roots: graph.roots.map(({ alias, coordinate }) => [alias, coordinate]),
    modules: graph.modules.map(({ coordinate, source }) => [coordinate, source]),
  })
}

function install(monaco: typeof Monaco, graph: GeometryTypeGraph | null, rootsEnabled: boolean) {
  const nextGraph = graph ?? emptyGraph
  const nextKey = `${rootsEnabled}:${graphKey(nextGraph)}`
  if (environmentMonaco === monaco && environmentKey === nextKey) return
  environmentDisposables.forEach((disposable) => disposable.dispose())
  environmentMonaco = monaco
  environmentKey = nextKey
  environmentDisposables = [
    monaco.typescript.typescriptDefaults.addExtraLib(rootsEnabled ? geometryRootTypes(nextGraph) : '', rootTypesPath),
    monaco.typescript.typescriptDefaults.addExtraLib(geometryCoordinateTypes(nextGraph), coordinateTypesPath),
    ...nextGraph.modules.map((module) =>
      monaco.typescript.typescriptDefaults.addExtraLib(
        module.source,
        `file:///geometries/${encodeURIComponent(module.coordinate)}.tsx`,
      ),
    ),
  ]
}

function exclusively<T>(run: () => Promise<T>) {
  const previous = environmentQueue
  let release: () => void = () => undefined
  environmentQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  return previous.then(run).finally(release)
}

export function initializeGeometryTypeEnvironment(monaco: typeof Monaco) {
  install(monaco, authoringGraph, authoringRootsEnabled)
}

export function setGeometryAuthoringGraph(graph: GeometryTypeGraph | null) {
  authoringGraph = graph
  void import('./monacoRuntime')
    .then(({ loadMonaco }) => loadMonaco())
    .then((monaco) => exclusively(async () => install(monaco, authoringGraph, authoringRootsEnabled)))
    .catch(() => undefined)
}

export function setGeometryAuthoringRootsEnabled(enabled: boolean) {
  authoringRootsEnabled = enabled
  void import('./monacoRuntime')
    .then(({ loadMonaco }) => loadMonaco())
    .then((monaco) => exclusively(async () => install(monaco, authoringGraph, authoringRootsEnabled)))
    .catch(() => undefined)
}

export function withGeometryTypeEnvironment<T>(
  monaco: typeof Monaco,
  graph: GeometryTypeGraph | undefined,
  rootsEnabled: boolean,
  run: () => Promise<T>,
) {
  return exclusively(async () => {
    install(monaco, graph ?? null, rootsEnabled)
    try {
      return await run()
    } finally {
      install(monaco, authoringGraph, authoringRootsEnabled)
    }
  })
}
