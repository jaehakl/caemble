export const shellCutawaysCode = `import {
  Material,
  structure,
  type BoxAttributes,
  type CurvedEdgeCylinderAttributes,
  type CurvedSurfaceSphereAttributes,
  type FiberAttributes,
  type Geometry,
} from '@caemble/core'

const curvedCylinderAttributes = {
  height: 16,
  azimuthalCurve: [
    { amplitude: 5, phase: 0 },
    { amplitude: 0, phase: 0 },
    { amplitude: 0.55, phase: 0.35 },
    { amplitude: 0.25, phase: 1.1 },
  ],
  verticalCurve: {
    origin: 0,
    coefficients: [1, 0, -0.0015],
  },
  azimuthalSegments: 32,
  verticalSegments: 8,
  rotate: { axis: [0, 0, 1], angle: Math.PI / 32 },
} satisfies CurvedEdgeCylinderAttributes

const curvedSphereAttributes = {
  azimuthalCurve: [
    { amplitude: 5, phase: 0 },
    { amplitude: 0, phase: 0 },
    { amplitude: 0.35, phase: 0.3 },
    { amplitude: 0.18, phase: 1.2 },
  ],
  polarCurve: [
    { amplitude: 1, phase: 0 },
    { amplitude: 0, phase: 0 },
    { amplitude: 0.08, phase: 0.4 },
  ],
  azimuthalSegments: 24,
  polarSegments: 12,
  rotate: { axis: [0, 0, 1], angle: Math.PI / 24 },
} satisfies CurvedSurfaceSphereAttributes

const fiberAttributes = {
  from: [0, 0, -9],
  to: [0, 0, 9],
  basePath: (t: number) => [2.5 * Math.sin(Math.PI * t), 0, -9 + 18 * t] as const,
  radius: 2.4,
  up: [0, 1, 0],
  pathSegments: 32,
  radialSegments: 12,
  rotate: { axis: [0, 0, 1], angle: Math.PI / 128 },
} satisfies FiberAttributes

const cutawayAttributes = {
  size: [20, 20, 24],
  pos: [0, -10, 0],
} satisfies BoxAttributes

type ShapeKind = 'curvedCylinder' | 'curvedSphere' | 'fiber' | 'cutaway'

const Shape: Geometry<{
  kind: ShapeKind
  offsets?: readonly number[]
}> = ({ kind, offsets }) => {
  const geometry = kind === 'curvedCylinder'
    ? <curvedEdgeCylinder {...curvedCylinderAttributes} />
    : kind === 'curvedSphere'
      ? <curvedSurfaceSphere {...curvedSphereAttributes} />
      : kind === 'fiber'
        ? <fiber {...fiberAttributes} />
        : <box {...cutawayAttributes} />

  return offsets === undefined
    ? geometry
    : <shell offsets={offsets}>{geometry}</shell>
}

const ShellCutaway: Geometry<{
  kind: Exclude<ShapeKind, 'cutaway'>
  offsets: readonly number[]
}> = ({ kind, materials, offsets }) => {
  if (!materials || materials.length !== offsets.length + 1) {
    throw new Error('ShellCutaway requires one core Material and one Material per shell layer.')
  }

  const core = offsets[0] < 0
    ? (
        <subtract>
          <Shape id="core" kind={kind} materials={[materials[0]]} />
          <Shape id="inner-shell" kind={kind} offsets={[offsets[0]]} materials={[materials[0]]} />
        </subtract>
      )
    : <Shape id="core" kind={kind} materials={[materials[0]]} />

  return (
    <subtract>
      <>
        {core}
        <Shape id="shell" kind={kind} offsets={offsets} materials={materials.slice(1)} />
      </>
      <Shape id="cutaway" kind="cutaway" materials={[materials[0]]} />
    </subtract>
  )
}

const coreMaterial = new Material('Core', { color: '#475569' })
const layer1Material = new Material('Layer 1', { color: '#0ea5e9' })
const layer2Material = new Material('Layer 2', { color: '#f59e0b' })
const layer3Material = new Material('Layer 3', { color: '#d946ef' })

export default structure({
  lengthUnit: 'mm',
  geometry: () => (
    <>
      <ShellCutaway
        id="cylinder"
        kind="curvedCylinder"
        offsets={[0.5]}
        pos={[-22, 0, 0]}
        materials={[coreMaterial, layer1Material]}
      />
      <ShellCutaway
        id="sphere"
        kind="curvedSphere"
        offsets={[0.5, 1]}
        materials={[coreMaterial, layer1Material, layer2Material]}
      />
      <ShellCutaway
        id="fiber"
        kind="fiber"
        offsets={[-0.5, 0.5, 1]}
        pos={[22, 0, 0]}
        materials={[coreMaterial, layer1Material, layer2Material, layer3Material]}
      />
    </>
  ),
  varsSchema: {},
})
`
