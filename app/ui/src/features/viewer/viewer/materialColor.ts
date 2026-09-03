import type { CadSceneMaterial, CadScenePart } from '@/lib/cad/evaluation/types'

export const unassignedGeometryColor = '#475569'

export function materialColor(material: CadSceneMaterial | undefined) {
  return typeof material?.variables.color === 'string' ? material.variables.color : undefined
}

export function automaticMaterialColor(role: string) {
  let hash = 0x811c9dc5
  new TextEncoder().encode(role).forEach((byte) => {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  })
  const hue = hash % 360
  const saturation = 62 + ((hash >>> 9) % 18)
  const lightness = 48 + ((hash >>> 17) % 10)
  const chroma = (1 - Math.abs((2 * lightness) / 100 - 1)) * (saturation / 100)
  const section = hue / 60
  const intermediate = chroma * (1 - Math.abs((section % 2) - 1))
  const [red, green, blue] =
    section < 1
      ? [chroma, intermediate, 0]
      : section < 2
        ? [intermediate, chroma, 0]
        : section < 3
          ? [0, chroma, intermediate]
          : section < 4
            ? [0, intermediate, chroma]
            : section < 5
              ? [intermediate, 0, chroma]
              : [chroma, 0, intermediate]
  const match = lightness / 100 - chroma / 2
  return `#${[red, green, blue]
    .map((component) =>
      Math.round((component + match) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

export function scenePartColor(part: Readonly<{ material?: CadScenePart['material']; materialRole?: string }>) {
  const explicit = materialColor(part.material)
  if (explicit !== undefined) return explicit
  return typeof part.materialRole === 'string' && part.materialRole.trim()
    ? automaticMaterialColor(part.materialRole)
    : undefined
}
