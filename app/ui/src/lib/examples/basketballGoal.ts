export const basketballGoalCode = `import { experiment, type Geometry } from '@caemble/core'

const BasketballGoal: Geometry = () => (
  <>
    {/* Vertical support pole. Primitive axes and all dimensions use the Experiment lengthUnit. */}
    <cylinder id="pole" radius={3} height={300} position={[0, 0, 150]} />

    {/* A cylinder is Z-aligned by default. +90 degrees around X makes this arm Y-aligned. */}
    <cylinder
      id="arm"
      radius={2.5}
      height={200}
      position={[0, 100, 298]}
      rotation={[Math.PI / 2, 0, 0]}
    />

    <box id="backboard" size={[180, 5, 100]} position={[0, 200, 280]} />

    {/* Subtract a taller inner cylinder to create an actual annular rim. */}
    <subtract id="rim" position={[0, 155, 280]}>
      <cylinder radius={22} height={1.5} />
      <cylinder radius={19} height={2} />
    </subtract>
  </>
)

export default experiment({
  lengthUnit: 'mm',
  varsSchema: {},
  geometry: () => <BasketballGoal id="goal" />,
  recordedData: {},
})
`

export const basketballGoalExample = Object.freeze({
  id: 'basketball-goal',
  title: 'Basketball Goal',
  description:
    'CAD API v7의 position, intrinsic XYZ Euler rotation, primitive/operation id와 Boolean ring 작성을 함께 보여주는 검증 예제입니다.',
  code: basketballGoalCode,
  mode: 'geometry-preview' as const,
})
