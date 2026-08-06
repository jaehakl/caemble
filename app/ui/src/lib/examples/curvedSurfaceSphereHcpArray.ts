export const curvedSurfaceSphereHcpArrayCode = `import {
  Material,
  structure,
  type Geometry,
} from '@caemble/core'

const tau = Math.PI * 2
const arrayShape = [4, 4, 3] as const
const latticeSpacing = 7
const layerSpacing = Math.sqrt(2 / 3) * latticeSpacing

const cellTensor = (value: number) =>
  Array.from({ length: arrayShape[0] }, () =>
    Array.from({ length: arrayShape[1] }, () =>
      Array.from({ length: arrayShape[2] }, () => value),
    ),
  )

const layerOffsets = Array.from({ length: arrayShape[0] }, () =>
  Array.from({ length: arrayShape[1] }, () =>
    Array.from({ length: arrayShape[2] }, (_, z) =>
      z % 2 === 0
        ? [0, 0, 0]
        : [latticeSpacing / 2, (Math.sqrt(3) * latticeSpacing) / 6, 0],
    ),
  ),
)

const CurvedParticle: Geometry<{
  baseRadius: number
  azimuthalMode2Amplitude: number
  azimuthalMode2Phase: number
  azimuthalMode3Amplitude: number
  azimuthalMode3Phase: number
  polarMode2Amplitude: number
  polarMode2Phase: number
}> = ({
  baseRadius,
  azimuthalMode2Amplitude,
  azimuthalMode2Phase,
  azimuthalMode3Amplitude,
  azimuthalMode3Phase,
  polarMode2Amplitude,
  polarMode2Phase,
}) => (
  <curvedSurfaceSphere
    azimuthalCurve={[
      { amplitude: baseRadius, phase: 0 },
      { amplitude: 0, phase: 0 },
      { amplitude: azimuthalMode2Amplitude, phase: azimuthalMode2Phase },
      { amplitude: azimuthalMode3Amplitude, phase: azimuthalMode3Phase },
    ]}
    polarCurve={[
      { amplitude: 1, phase: 0 },
      { amplitude: 0, phase: 0 },
      { amplitude: polarMode2Amplitude, phase: polarMode2Phase },
    ]}
    azimuthalSegments={32}
    polarSegments={16}
  />
)

export default structure({
  lengthUnit: 'mm',
  geometry: ({ vars }) => (
    <array
      shape={arrayShape}
      period={[latticeSpacing, latticeSpacing, layerSpacing]}
      axes={{
        x: [1, 0, 0],
        y: [0.5, Math.sqrt(3) / 2, 0],
        z: [0, 0, 1],
      }}
      inject={{
        pos: layerOffsets,
        baseRadius: vars.baseRadius,
        azimuthalMode2Amplitude: vars.azimuthalMode2Amplitude,
        azimuthalMode2Phase: vars.azimuthalMode2Phase,
        azimuthalMode3Amplitude: vars.azimuthalMode3Amplitude,
        azimuthalMode3Phase: vars.azimuthalMode3Phase,
        polarMode2Amplitude: vars.polarMode2Amplitude,
        polarMode2Phase: vars.polarMode2Phase,
      }}
    >
      <CurvedParticle
        id="particle"
        baseRadius={3.125}
        azimuthalMode2Amplitude={0.08}
        azimuthalMode2Phase={0}
        azimuthalMode3Amplitude={0.04}
        azimuthalMode3Phase={0}
        polarMode2Amplitude={0.015}
        polarMode2Phase={0}
        materials={[
          new Material('HCP Particle', {
            'general.mass_density': {
              dtype: 'float64',
              value: 1.05,
              errorRate: 0,
              unit: 'g.cm-3',
            },
            color: '#7c3aed',
          }),
        ]}
      />
    </array>
  ),
  varsSchema: {
    baseRadius: {
      min: cellTensor(3.05),
      max: cellTensor(3.2),
    },
    azimuthalMode2Amplitude: {
      min: cellTensor(0.05),
      max: cellTensor(0.12),
    },
    azimuthalMode2Phase: {
      min: cellTensor(0),
      max: cellTensor(tau),
    },
    azimuthalMode3Amplitude: {
      min: cellTensor(0.02),
      max: cellTensor(0.06),
    },
    azimuthalMode3Phase: {
      min: cellTensor(0),
      max: cellTensor(tau),
    },
    polarMode2Amplitude: {
      min: cellTensor(0.01),
      max: cellTensor(0.025),
    },
    polarMode2Phase: {
      min: cellTensor(0),
      max: cellTensor(tau),
    },
  },
})
`
