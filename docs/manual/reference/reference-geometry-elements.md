# 기본 형상과 조합 연산 선택하기

형상은 기본 요소를 배치하고 합치거나 빼는 방식으로 만듭니다. 처음에는 `Box`, `Cylinder`, `Sphere`로 표현할 수 있는지부터 살펴보세요. [Geometry 기본 구조](reference-geometry-skeleton.md)를 알고 있다면 이 문서에서 필요한 요소와 조합 방법을 찾을 수 있습니다.

## 기본 요소 고르기

기본 형상 요소(Primitive)는 `@caemble/core`에서 PascalCase 이름으로 가져오고, 조합 연산은 소문자 JSX 태그로 작성합니다. 곡선이 필요하면 `CurvedEdgeCylinder`, `Fiber`, `AsphericCylinder`, `Ellipsoid`, `Hyperboloid`, `Paraboloid`를 살펴보세요. 속성의 타입, 필수 여부, 기본값, 제약, 기준 원점, 표면 번호와 실행 가능한 예제는 [형상 카탈로그](/doc?help=geometry)에서 확인합니다.

## 여러 형상 조합하기

| 연산   | 필요한 자식 요소                                              | 핵심 규칙                                                             |
| ----------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| `translate` | 1개 이상                                                | `offset` Vec3로 child group을 상대 이동                               |
| `rotate`    | 1개 이상                                                | `axis`와 radian `angle`로 오른손 axis-angle 회전                      |
| `scale`     | 1개 이상                                                | `x`, `y`, `z` 축별 배율을 local 원점 기준으로 적용                    |
| `union`     | 1개 이상                                                | 모든 child를 하나의 결과로 결합                                       |
| `subtract`  | 2개 이상                                                | 첫 child가 base, 이후 child는 cutter                                  |
| `intersect` | 2개 이상                                                | 모든 child의 공통 체적만 유지                                         |
| `array`     | 정확히 1개의 identified intrinsic 또는 `Geometry` child | `shape`, `period`, 선택적 `axes`와 canonical `inject`로 instance 생성 |

Boolean 연산에서는 자식 요소의 순서도 결과를 결정합니다. 고리를 만들려면 큰 Cylinder에서 더 높고 반경이 작은 Cylinder를 빼 실제 구멍을 표현하세요. 두께 0, 음수 크기, NaN/Infinity, 방향을 정할 수 없는 축처럼 유효하지 않은 입력은 평가 단계에서 거부됩니다.

재료는 상위 형상에서 역할별로 전달하고, 실제 부품에서 `body` 역할에 연결합니다. 생략하면 부모의 재료 맵을 물려받고, 명시하면 교체하며, `materials={{}}`는 상속을 지웁니다. 자세한 내용은 [재료 연결 안내](/doc?help=manual&item=program-materials)를 참고하세요.

## 곡면과 경로의 상세 규칙

### 연속 형상과 길이 단위

Fiber와 네 신규 primitive는 연속 수식으로 정의하고 mesh를 파생합니다. `position/rotation/scale`, Boolean과 instance를 적용해도 원본 정의와 표면 출처를 유지합니다. 자동 재중심화는 하지 않습니다. 길이·반경·초점거리는 scene의 길이 단위를 따릅니다. 네 신규 곡면의 preview 기본값은 `tessellation: { radialSegments: 64, meridianSegments: 32 }`이고 analysis에서는 정련 profile을 적용합니다. 해상도 변경은 형상 hash를 바꾸지 않습니다.

| Primitive          | 연속 정의와 범위                                                                                                                       | 표면 번호                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `Ellipsoid`        | `focalDistance=f`, `axialRadius=a`, `a>f≥0`. 초점은 `[0,0,±f]`, 횡반축은 `√(a²−f²)`. `f=0`은 반경 `a`의 구                             | `0: Outer`; cap 없음             |
| `Hyperboloid`      | `focalDistance=f>a=axialRadius>0`, `radius=r>0`. `b²=f²−a²`, `z(ρ)=a√(1+ρ²/b²)`, `0≤ρ≤r`. 최대 높이 `zTop=a√(1+r²/b²)`의 원판으로 닫음 | `1: Side`, `2: Top`; `0` 없음    |
| `Paraboloid`       | `focalLength=f>0`, `radius=r>0`. vertex는 원점, 초점은 `[0,0,f]`. `z(ρ)=ρ²/(4f)`, `0≤ρ≤r`. `zTop=r²/(4f)`의 원판으로 닫음              | `1: Side`, `2: Top`; `0` 없음    |
| `AsphericCylinder` | 필수 `radius=r`, `centerThickness=h`. 아래·위 vertex는 `±h/2`, 생략한 면은 평면                                                        | `0: Bottom`, `1: Side`, `2: Top` |

Hyperboloid는 이엽 회전쌍곡면의 양의 Z 가지만 지원하며 원점은 초점 쌍의 중심입니다. 형상 높이는 `zTop−a`입니다. Hyperboloid·Paraboloid의 solid는 곡면과 top 원판 사이이며 별도 원통 옆면은 없습니다. Z 절단 입력, 음의 가지, 일엽 선택과 `focalLengths`는 받지 않습니다.

비구면의 `top/bottom`은 `{ curvature: c, conic: k, coefficients: [{ order: n, value: A_n }] }`입니다. 두 면 모두 sag의 양의 방향은 +Z이며 `sag(ρ)=cρ²/(1+√(1−(1+k)c²ρ²))+ΣA_nρⁿ`입니다. 차수는 중복 없는 짝수 `4,6,…`만 허용합니다. 전체 반경 구간에서 정의역과 양의 두께를 mesh와 독립적으로 검증하며, 특이한 가장자리나 유효성을 확인할 수 없는 입력은 거부합니다. 길이 변환율 `q`에 대해 곡률은 `1/q`, 차수 `n`의 계수는 `q^(1−n)`로 변환합니다. 두 면이 평면이면 같은 치수의 Cylinder입니다.

### Fiber 경로와 반경

기존 `from/to`와 숫자 `radius`를 유지합니다. 경로 입력은 `path: { start, direction, segments }`이며 구간은 `{ kind: 'line', length }` 또는 `{ kind: 'arc', radius, angle, normal }`입니다. 구간은 앞 구간의 끝점과 접선을 이어받습니다. `angle`은 부호 있는 radian, `normal`은 Fiber 로컬 좌표에서 굽힘 평면의 단위 법선입니다. 접선과 수직이어야 합니다.

반경은 숫자 또는 `radiusProfile: [{ s, radius }, …]`입니다. `s`는 실제 호 길이로 0부터 전체 길이까지 증가하고 반경은 구간별 선형 보간합니다. `path`와 `from/to`, `radius`와 `radiusProfile`을 동시에 지정할 수 없습니다. 경로·profile 경계는 반드시 mesh에 포함되며 반경 기울기의 꺾임을 보존합니다. 시작·끝에만 cap을 만들고 표면 번호는 `0: Start cap`, `1: Side`, `2: End cap`입니다.

Fiber의 mesh 설정은 `tessellation: { pathSegments: 128, radialSegments: 12 }`가 기본입니다. 굽힘의 특이점과 자기교차 또는 분리 여부를 확인할 수 없는 경로는 오류로 보고합니다.

### 이전 입력 이관

CAD `<shell>`과 `curvedSurfaceSphere`, Fiber callback·`basePath`·`helix`·`fourier`·`envelopePower`·기존 sampling 전용 입력은 제거되었습니다. 별칭이나 자동 변환은 제공하지 않습니다. 저장된 source를 새 계약으로 수정하고 UI·CLI·worker가 공유하는 canonical v2로 다시 빌드하세요. 구조해석 shell 요소는 유지합니다. 입체 재료층은 명시적 solid Boolean으로, 광학 박막은 [표면 박막 경계조건](/doc?help=manual&item=program-ray-tracing)으로 작성합니다. 반경 차이는 일정 거리 offset을 뜻하지 않습니다.

## 작성한 형상 확인하기

Viewer에서 예상한 체적과 구멍이 보이는지, 기준 원점과 재료가 맞는지 확인하세요. 이후 [형상 변환](reference-geometry-transforms.md)으로 배치를 조절하고 [ID와 그룹](reference-geometry-identity.md)으로 해석 대상을 지정할 수 있습니다.
