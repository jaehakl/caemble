export const shellCutawaysCode = `import {
  Box,
  CurvedEdgeCylinder,
  CurvedSurfaceSphere,
  Fiber,
  experiment,
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
  rotation: [0, 0, Math.PI / 32],
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
  rotation: [0, 0, Math.PI / 24],
} satisfies CurvedSurfaceSphereAttributes

const fiberAttributes = {
  from: [0, 0, -9],
  to: [0, 0, 9],
  basePath: (t: number) => [2.5 * Math.sin(Math.PI * t), 0, -9 + 18 * t] as const,
  radius: 2.4,
  up: [0, 1, 0],
  pathSegments: 32,
  radialSegments: 12,
  rotation: [0, 0, Math.PI / 128],
} satisfies FiberAttributes

const cutawayAttributes = {
  size: [20, 20, 24],
  position: [0, -10, 0],
} satisfies BoxAttributes

type ShapeKind = 'curvedCylinder' | 'curvedSphere' | 'fiber' | 'cutaway'

const Shape: Geometry<{
  kind: ShapeKind
  offsets?: Readonly<Record<string, number>>
}> = ({ kind = 'curvedCylinder', offsets = undefined }) => {
  const geometry = kind === 'curvedCylinder'
    ? <CurvedEdgeCylinder {...curvedCylinderAttributes} />
    : kind === 'curvedSphere'
      ? <CurvedSurfaceSphere {...curvedSphereAttributes} />
      : kind === 'fiber'
        ? <Fiber {...fiberAttributes} />
        : <Box {...cutawayAttributes} />

  return offsets === undefined
    ? geometry
    : <shell offsets={offsets}>{geometry}</shell>
}

const ShellCutaway: Geometry<{
  kind: Exclude<ShapeKind, 'cutaway'>
  offsets: Readonly<Record<string, number>>
}> = ({
  kind = 'curvedCylinder',
  materials,
  offsets = { inner: -1, outer: 1 },
}) => {
  const sortedOffsets = Object.entries(offsets).sort((left, right) => left[1] - right[1])
  const [innerRole, innerOffset] = sortedOffsets[0]

  const core = innerOffset < 0
    ? (
        <subtract>
          <Shape id="core" kind={kind} materials={{ body: materials?.core }} />
          <Shape
            id="inner-shell"
            kind={kind}
            offsets={{ [innerRole]: innerOffset }}
            materials={{ [innerRole]: materials?.core }}
          />
        </subtract>
      )
    : <Shape id="core" kind={kind} materials={{ body: materials?.core }} />

  return (
    <subtract>
      <>
        {core}
        <Shape id="shell" kind={kind} offsets={offsets} />
      </>
      <Shape id="cutaway" kind="cutaway" materials={{ body: materials?.core }} />
    </subtract>
  )
}

export default experiment({
  lengthUnit: 'mm',
  geometry: () => (
    <>
      <ShellCutaway
        id="cylinder"
        kind="curvedCylinder"
        offsets={{ layer1: 0.5 }}
        position={[-22, 0, 0]}
      />
      <ShellCutaway
        id="sphere"
        kind="curvedSphere"
        offsets={{ layer1: 0.5, layer2: 1 }}
      />
      <ShellCutaway
        id="fiber"
        kind="fiber"
        offsets={{ inner: -0.5, layer1: 0.5, layer2: 1 }}
        position={[22, 0, 0]}
      />
    </>
  ),
  varsSchema: {},
  recordedData: {},
})
`
