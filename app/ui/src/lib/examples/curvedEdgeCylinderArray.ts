export const curvedEdgeCylinderArrayCode = `import {
  CurvedEdgeCylinder,
  experiment,
  type Geometry,
} from '@caemble/core'

const tau = Math.PI * 2
const arrayShape = [4, 4, 1] as const

const cellTensor = (value: number) =>
  Array.from({ length: arrayShape[0] }, () =>
    Array.from({ length: arrayShape[1] }, () =>
      Array.from({ length: arrayShape[2] }, () => value),
    ),
  )

const CurvedCell: Geometry<{
  height: number
  baseRadius: number
  mode2Amplitude: number
  mode2Phase: number
  mode3Amplitude: number
  mode3Phase: number
  verticalSlope: number
  verticalCurvature: number
}> = ({
  height = 10,
  baseRadius = 4.6,
  mode2Amplitude = 0.5,
  mode2Phase = 0,
  mode3Amplitude = 0.25,
  mode3Phase = 0,
  verticalSlope = 0,
  verticalCurvature = 0,
}) => (
  <CurvedEdgeCylinder
    height={height}
    azimuthalCurve={[
      { amplitude: baseRadius, phase: 0 },
      { amplitude: 0, phase: 0 },
      { amplitude: mode2Amplitude, phase: mode2Phase },
      { amplitude: mode3Amplitude, phase: mode3Phase },
    ]}
    verticalCurve={{
      origin: 0,
      coefficients: [1, verticalSlope, verticalCurvature],
    }}
    azimuthalSegments={48}
    verticalSegments={16}
  />
)

export default experiment({
  lengthUnit: 'mm',
  geometry: ({ vars }) => (
    <array
      shape={arrayShape}
      period={[14, 14, 0]}
      inject={{
        height: vars.height,
        baseRadius: vars.baseRadius,
        mode2Amplitude: vars.mode2Amplitude,
        mode2Phase: vars.mode2Phase,
        mode3Amplitude: vars.mode3Amplitude,
        mode3Phase: vars.mode3Phase,
        verticalSlope: vars.verticalSlope,
        verticalCurvature: vars.verticalCurvature,
      }}
    >
      <CurvedCell
        id="cell"
        height={10}
        baseRadius={4.6}
        mode2Amplitude={0.5}
        mode2Phase={0}
        mode3Amplitude={0.25}
        mode3Phase={0}
        verticalSlope={0}
        verticalCurvature={0}
      />
    </array>
  ),
  varsSchema: {
    height: {
      min: cellTensor(8),
      max: cellTensor(12),
    },
    baseRadius: {
      min: cellTensor(4.2),
      max: cellTensor(5),
    },
    mode2Amplitude: {
      min: cellTensor(0.2),
      max: cellTensor(0.8),
    },
    mode2Phase: {
      min: cellTensor(0),
      max: cellTensor(tau),
    },
    mode3Amplitude: {
      min: cellTensor(0.1),
      max: cellTensor(0.45),
    },
    mode3Phase: {
      min: cellTensor(0),
      max: cellTensor(tau),
    },
    verticalSlope: {
      min: cellTensor(-0.02),
      max: cellTensor(0.02),
    },
    verticalCurvature: {
      min: cellTensor(-0.005),
      max: cellTensor(0.005),
    },
  },
  recordedData: {},
})
`
