import { analyzeGeometrySource } from '../source/sourceAnalysis'

export type GeometryTypeGraph = Readonly<{
  entryImports: readonly Readonly<{ exportName: string; alias: string; coordinate: string }>[]
  modules: readonly Readonly<{
    coordinate: string
    source: string
    imports: readonly Readonly<{ exportName: string; alias: string; coordinate: string }>[]
  }>[]
}>

export function geometryCoordinateTypes(graph: GeometryTypeGraph) {
  return graph.modules
    .map(({ coordinate, source }) => {
      let exports: readonly Readonly<{ name: string; defaultedProps: readonly string[] }>[] = []
      try {
        exports = analyzeGeometrySource(source, { allowLocal: true }).exports
      } catch {
        // The policy diagnostic belongs to the source model; keep other modules available while typing.
      }
      const sourceModule = JSON.stringify(`./geometries/${encodeURIComponent(coordinate)}`)
      const declarations = exports.map(({ name, defaultedProps }) => {
        const sourceType = `typeof import(${sourceModule})[${JSON.stringify(name)}]`
        if (defaultedProps.length === 0) return `  const ${name}: ${sourceType}\n  export { ${name} }`
        const keys = defaultedProps.map((item) => JSON.stringify(item)).join(' | ')
        return `  type ${name}Component = ${sourceType}
  type ${name}Props = Parameters<${name}Component>[0]
  type ${name}DefaultedProps = Extract<${keys}, keyof ${name}Props>
  const ${name}: (props: Omit<${name}Props, ${name}DefaultedProps> & Partial<Pick<${name}Props, ${name}DefaultedProps>>) => ReturnType<${name}Component>
  export { ${name} }`
      })
      return `declare module ${JSON.stringify(coordinate)} {
${declarations.join('\n')}
}`
    })
    .join('\n')
}
