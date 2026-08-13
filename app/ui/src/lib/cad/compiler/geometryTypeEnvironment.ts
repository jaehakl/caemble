import type * as Monaco from 'monaco-editor'
import { geometryCoordinateTypes, type GeometryTypeGraph } from './geometryTypes'

const emptyGraph: GeometryTypeGraph = Object.freeze({ entryImports: Object.freeze([]), modules: Object.freeze([]) })
const coordinateTypesPath = 'file:///geometry-coordinates.d.ts'

let environmentMonaco: typeof Monaco | null = null
let environmentKey = ''
let environmentDisposables: Monaco.IDisposable[] = []
let authoringGraph: GeometryTypeGraph | null = null
let environmentQueue = Promise.resolve()

function graphKey(graph: GeometryTypeGraph) {
  return JSON.stringify(
    graph.modules.map(({ coordinate, source, imports }) => [
      coordinate,
      source,
      imports.map(({ exportName, alias, coordinate: importedCoordinate }) => [exportName, alias, importedCoordinate]),
    ]),
  )
}

function install(monaco: typeof Monaco, graph: GeometryTypeGraph | null) {
  const nextGraph = graph ?? emptyGraph
  const nextKey = graphKey(nextGraph)
  if (environmentMonaco === monaco && environmentKey === nextKey) return
  environmentDisposables.forEach((item) => item.dispose())
  environmentMonaco = monaco
  environmentKey = nextKey
  environmentDisposables = [
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
  install(monaco, authoringGraph)
}

export function setGeometryAuthoringGraph(graph: GeometryTypeGraph | null) {
  authoringGraph = graph
  void import('./monacoRuntime')
    .then(({ loadMonaco }) => loadMonaco())
    .then((monaco) => exclusively(async () => install(monaco, authoringGraph)))
    .catch(() => undefined)
}

export function withGeometryTypeEnvironment<T>(
  monaco: typeof Monaco,
  graph: GeometryTypeGraph | undefined,
  run: () => Promise<T>,
) {
  return exclusively(async () => {
    install(monaco, graph ?? null)
    try {
      return await run()
    } finally {
      install(monaco, authoringGraph)
    }
  })
}
