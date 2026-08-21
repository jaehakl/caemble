export function draftGeometrySource(packageName: string) {
  const exportName = packageName
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('')
  const name = /^[A-Z][A-Za-z0-9]*$/u.test(exportName) ? exportName : 'NewGeometry'
  return `import { type Geometry } from '@caemble/core'

export const ${name}: Geometry = () => <></>
`
}
