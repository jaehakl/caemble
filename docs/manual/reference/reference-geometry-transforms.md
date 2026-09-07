# Transform: direct props와 operation wrapper

Primitive, Boolean·shell·array operation과 `Geometry` component 호출은 같은 direct transform 계약을 사용합니다. `translate`·`rotate`·`scale` wrapper는 별도의 전용 prop 계약을 사용합니다.

| Prop | 형식 | 의미 |
| --- | --- | --- |
| `position` | `[x, y, z]` | parent 좌표계에서의 이동 |
| `rotation` | `[x, y, z]` | radian 단위의 intrinsic XYZ Euler, `THREE.Euler(x, y, z, "XYZ")`와 같은 의미 |
| `scale` | `[x, y, z]` | 축별 배율. 균일 배율은 세 값을 같게 작성 |

한 node 안에서는 **scale → rotation → position** 순서로 적용됩니다. parent와 child transform은 tree 계층대로 합성됩니다. 각도는 degree가 아니라 radian이므로 `Math.PI / 2`처럼 작성하세요.

부분 예시 — 아래 fence는 완성 파일이 아닌 단일 intrinsic element 식입니다.

```tsx
<Cylinder
  id="arm"
  radius={2.5}
  height={200}
  position={[0, 100, 298]}
  rotation={[Math.PI / 2, 0, 0]}
/>
```

여러 child를 한 local transform 아래 묶을 때는 lowercase operation wrapper를 사용합니다. Wrapper는 아래 전용 prop만 받고 direct transform prop과 섞지 않습니다. 안쪽 wrapper부터 적용되므로 다음 순서는 scale → rotate → translate입니다.

```tsx
import { Box, radians } from '@caemble/core'

<translate offset={[100, 0, 0]}>
  <rotate axis={[0, 0, 1]} angle={radians(90)}>
    <scale x={2} y={1} z={1}>
      <Box id="body" size={[20, 10, 5]} />
    </scale>
  </rotate>
</translate>
```

`radians(number)`와 `radians(Vec3)`는 degree를 radian으로 바꿉니다. Direct `rotation`은 intrinsic XYZ Euler Vec3이고, `<rotate>`는 오른손 법칙의 axis-angle이므로 두 표현의 의미를 구분하세요.

`pos`와 `{ axis, angle }` 형태의 `rotate`는 v7 안에서 기존 source를 잠시 옮기기 위한 deprecated 호환 문법입니다. 새 코드는 `position`과 `rotation`만 사용하세요. 같은 node에서 canonical family와 deprecated family를 섞을 수 없으며 `translation` prop은 지원하지 않습니다.
