import { analyzeGeometrySource } from '../source/sourceAnalysis'

export type GeometryTypeGraph = Readonly<{
  roots: readonly Readonly<{ alias: string; coordinate: string }>[]
  modules: readonly Readonly<{ coordinate: string; source: string }>[]
}>

export function geometryRootTypes(graph: GeometryTypeGraph) {
  return graph.roots
    .map(({ alias, coordinate }) => `declare const ${alias}: typeof import(${JSON.stringify(coordinate)}).default`)
    .join('\n')
}

export function geometryCoordinateTypes(graph: GeometryTypeGraph) {
  return graph.modules
    .map(({ coordinate, source }) => {
      let defaultedProps: readonly string[] = []
      try {
        defaultedProps = analyzeGeometrySource(source).defaultedProps
      } catch {
        // Keep the current source installed while it is incomplete; policy diagnostics report the source error.
      }
      const sourceType = `typeof import(${JSON.stringify(`./geometries/${encodeURIComponent(coordinate)}`)}).default`
      if (defaultedProps.length === 0) {
        return `declare module ${JSON.stringify(coordinate)} {
  const geometry: ${sourceType}
  export default geometry
}`
      }
      const keys = defaultedProps.map((name) => JSON.stringify(name)).join(' | ')
      return `declare module ${JSON.stringify(coordinate)} {
  type GeometryComponent = ${sourceType}
  type GeometryProps = Parameters<GeometryComponent>[0]
  type DefaultedProps = Extract<${keys}, keyof GeometryProps>
  const geometry: (props: Omit<GeometryProps, DefaultedProps> & Partial<Pick<GeometryProps, DefaultedProps>>) => ReturnType<GeometryComponent>
  export default geometry
}`
    })
    .join('\n')
}
