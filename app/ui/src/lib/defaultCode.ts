export const defaultCode = `import {
  Mat,
  Material,
  structure,
  type Geometry,
  type Vec3,
} from '@caemble/core'

const Conductor: Geometry<{
  notchPosition: Vec3
  notchSize: Vec3
  size: Vec3
}> = ({ notchPosition, notchSize, size }) => (
  <subtract>
    <box size={size} />
    <box pos={notchPosition} size={notchSize} />
  </subtract>
)

export default structure({
  lengthUnit: 'mm',
  geometry: ({ vars }) => (
    <Conductor
      id="conductor"
      size={vars.conductorSize}
      notchPosition={vars.notchPosition}
      notchSize={vars.notchSize}
      materials={[
        new Material('Copper', 'reference', {
          errorRate: 0.001,
          'electrical.conductivity': {
            dtype: 'float64',
            value: Mat(vars.electricalConductivity),
            unit: 'S.m-1',
          },
          color: '#d97706',
        }),
      ]}
    />
  ),
  varsSchema: {
    conductorSize: { min: [100, 12, 10], max: [100, 12, 10] },
    notchSize: { min: [20, 4, 5], max: [40, 6, 7] },
    notchPosition: { min: [-10, 4, 2.5], max: [10, 5, 3.5] },
    electricalConductivity: { min: 5.96e7, max: 5.96e7 },
  },
  geometryGroup: {
    conductor: ['conductor'],
  },
  surfaceGroup: {
    sourceTerminal: ['conductor/surface-1'],
    referenceTerminal: ['conductor/surface-2'],
  },
})
`
