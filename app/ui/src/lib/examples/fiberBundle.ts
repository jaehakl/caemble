export const fiberBundleCode = `import {
  Material,
  experiment,
  type FiberFourierMode,
  type Geometry,
  type Vec3,
} from '@caemble/core'

class Polymer extends Material {
  toMaterialModel() {
    return this.variables
  }
}

const strandFrom = [0, 0, -45] as const
const strandTo = [0, 0, 45] as const

const Strand: Geometry<{
  bend: Vec3
  bundleRadius: number
  fiberRadius: number
  fourier: readonly FiberFourierMode[]
  phase: number
  turns: number
}> = ({ bend, bundleRadius, fiberRadius, fourier, phase, turns }) => {
  const basePath = (t: number) => {
    const arc = Math.sin(Math.PI * t)
    return [
      strandFrom[0] + (strandTo[0] - strandFrom[0]) * t + bend[0] * arc,
      strandFrom[1] + (strandTo[1] - strandFrom[1]) * t + bend[1] * Math.sin(Math.PI * 2 * t),
      strandFrom[2] + (strandTo[2] - strandFrom[2]) * t + bend[2] * arc,
    ] as const
  }

  return (
    <fiber
      from={strandFrom}
      to={strandTo}
      basePath={basePath}
      radius={(s) => fiberRadius * (1 - 0.6 * s)}
      helix={{
        turns,
        phase,
        radius: (_u, theta) => bundleRadius * Math.exp(0.08 * Math.cos(2 * theta)),
      }}
      fourier={fourier}
      envelopePower={2}
      up={[1, 0, 0]}
      pathSegments={128}
      radialSegments={12}
    />
  )
}

const Bundle: Geometry<{
  materials: Material[]
  bend: Vec3
  bundleRadius: number
  fiberRadius: number
  fourier: readonly FiberFourierMode[]
  turns: number
}> = ({ bend, bundleRadius, fiberRadius, fourier, turns }) => (
  <>
    <Strand
      id="1"
      bend={bend}
      bundleRadius={bundleRadius}
      fiberRadius={fiberRadius}
      fourier={fourier}
      phase={0}
      turns={turns}
    />
    <Strand
      id="2"
      bend={bend}
      bundleRadius={bundleRadius}
      fiberRadius={fiberRadius}
      fourier={fourier}
      phase={(Math.PI * 2) / 3}
      turns={turns}
    />
    <Strand
      id="3"
      bend={bend}
      bundleRadius={bundleRadius}
      fiberRadius={fiberRadius}
      fourier={fourier}
      phase={(Math.PI * 4) / 3}
      turns={turns}
    />
  </>
)

export default experiment({
  lengthUnit: 'mm',
  geometry: ({ vars }) => {
    const fourier = vars.fourierModes.map(([amplitude, phase]) => ({
      amplitude,
      phase,
    }))

    return (
      <Bundle
        id="bundle"
        bend={vars.bend}
        bundleRadius={vars.bundleRadius}
        fiberRadius={vars.fiberRadius}
        fourier={fourier}
        turns={vars.turns}
        materials={[
          new Polymer('Tapered Fiber', {
            'general.mass_density': {
              dtype: 'float64',
              value: vars.density,
              errorRate: 0,
              unit: 'g.cm-3',
            },
            color: '#7c3aed',
          }),
        ]}
      />
    )
  },
  varsSchema: {
    bend: {
      min: [-12, -8, -4],
      max: [12, 8, 4],
    },
    bundleRadius: { min: 3, max: 7 },
    fiberRadius: { min: 0.8, max: 1.6 },
    turns: { min: 5, max: 11 },
    density: { min: 1.18, max: 1.18 },
    fourierModes: {
      min: [[0, 0], [0, 0], [0, 0]],
      max: [[1.2, Math.PI * 2], [0.6, Math.PI * 2], [0.3, Math.PI * 2]],
    },
  },
  geometryGroup: {
    bundle: ['bundle'],
  },
  surfaceGroup: {
    starts: ['bundle.1/surface-1', 'bundle.2/surface-1', 'bundle.3/surface-1'],
  },
  recordedData: {},
})
`
