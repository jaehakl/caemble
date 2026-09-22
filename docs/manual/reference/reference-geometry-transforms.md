# 형상을 이동·회전·확대하는 방법

형상을 원하는 위치에 놓으려면 위치·회전·배율을 지정합니다. **요소 하나의 속성으로 지정하는 방식**과 **여러 요소를 변환 연산으로 감싸는 방식**을 사용할 수 있습니다. 좌표계가 낯설다면 [Geometry 기본 구조](reference-geometry-skeleton.md)를 먼저 읽어 주세요.

## 요소의 속성으로 변환하기

기본 형상 요소, Boolean·array 연산, `Geometry` 컴포넌트 호출에는 같은 변환 속성을 사용합니다. 음의 배율은 방향을 반전시키고 법선에는 역전치 변환을 적용합니다. 배율에 0을 지정할 수는 없습니다.

| 속성       | 형식        | 의미                                                                         |
| ---------- | ----------- | ---------------------------------------------------------------------------- |
| `position` | `[x, y, z]` | 부모 좌표계에서의 이동                                                     |
| `rotation` | `[x, y, z]` | 라디안 단위의 intrinsic XYZ Euler 회전. `THREE.Euler(x, y, z, "XYZ")`와 같은 의미 |
| `scale`    | `[x, y, z]` | 축별 배율. 균일 배율은 세 값을 같게 작성                                     |

한 요소 안에서는 **scale → rotation → position** 순서로 적용합니다. 부모와 자식의 변환은 형상 트리의 계층대로 합성됩니다. 각도 단위는 라디안이므로 90°를 입력하려면 `Math.PI / 2`처럼 작성하세요.

아래는 Cylinder 요소 하나를 배치하는 부분 예시입니다. 완성 파일이 아니므로 사용하는 소스의 import와 형상 함수 안에 맞추어 읽어 주세요.

```tsx
<Cylinder
  id="arm"
  radius={2.5}
  height={200}
  position={[0, 100, 298]}
  rotation={[Math.PI / 2, 0, 0]}
/>
```

## 여러 요소를 한꺼번에 변환하기

여러 자식 요소에 같은 로컬 변환을 적용하려면 소문자 연산 태그 `translate`·`rotate`·`scale`로 감쌉니다. 이 태그는 아래의 전용 속성을 사용하며 앞서 설명한 직접 변환 속성과 섞지 않습니다. 안쪽부터 적용하므로 다음 부분 예시의 순서는 scale → rotate → translate입니다.

```tsx
import { Box, radians } from "@caemble/core";

<translate offset={[100, 0, 0]}>
  <rotate axis={[0, 0, 1]} angle={radians(90)}>
    <scale x={2} y={1} z={1}>
      <Box id="body" size={[20, 10, 5]} />
    </scale>
  </rotate>
</translate>;
```

`radians(number)`와 `radians(Vec3)`는 도 단위 값을 라디안으로 바꿉니다. `rotation`은 intrinsic XYZ Euler Vec3이고, `<rotate>`는 회전축과 각도(axis-angle)를 사용합니다. 두 표현 모두 회전이지만 같은 형태의 입력은 아니므로 구분해 주세요.

## 기존 코드를 옮길 때

`pos`와 `{ axis, angle }` 형태의 `rotate`는 v7에서 기존 소스를 옮기기 위해 남겨 둔 이전 문법입니다. 새 코드의 직접 변환에는 `position`과 `rotation`을 사용하세요. 같은 요소에서 현재 문법과 이전 문법을 섞을 수 없으며 `translation` 속성은 지원하지 않습니다.

배치가 예상과 다르면 **길이 단위 → 각도 단위 → 변환 순서 → 부모의 변환** 순서로 점검해 보세요. 해석 대상의 ID까지 확인하려면 [형상 ID와 그룹](reference-geometry-identity.md)을 참고하세요.
