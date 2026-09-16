# CSG 강체 운동과 관측 Grid

강체 Solver는 Canonical Geometry로부터 연결된 물질 영역을 준비하고,
공용 `methods.rigid`의 배치 배열 연산으로 운동을 계산한다. Catalog의 현재
Solver 계약과 실행 가능한 예제는 SQLite에서 조회한다. 이 문서는 그 계약을
구현하는 수치·상태·표시 경계를 설명한다.

## 형상과 질량특성

GeometryService의 solid component 경로는 곡면 분할 profile을 Boolean
계산 전에 적용한다. 기존 Solver의 기본 삼각화와 preview를 변경하지 않는다.
관측 Box와 Grid는 이 계산에 참여하지 않는다. Profile과 backend 버전을
포함한 run cache가 mesh를 보존하며, cache miss와 hit의 결과 의미는 같다.

연결된 경계 표면과 연결된 물질은 다르다. Hollow solid의 안쪽 표면은
음의 부호 체적을 갖는 cavity 경계다. 이를 가장 가까운 바깥 양의 shell에
귀속하고, cavity 안의 독립 물질 island는 별도 body로 유지한다. 경계의
방향을 보존하며 tetrahedron별 체적에 절댓값을 적용하지 않는다.

표면 triangle과 가까운 기준점으로 구성한 부호 tetrahedron의 체적,
1차 모멘트와 2차 모멘트를 적분한다. COM으로 평행축 이동하여 대칭적인
일반 관성텐서를 얻으며, 비대각 관성 성분도 유지한다. 열린 경계, 빈
solid, 비정상 방향, 비양수 체적·밀도와 유효하지 않은 관성은 오류다.

Root의 바깥 transform chain에서 원점과 proper rotation을 분리한다.
비균일 scale과 reflection은 기준 mesh 안에 남는다. 같은 root에서
분리된 body는 root frame을 공유하며 COM은 서로 다르다. 위치는 항상
COM의 world 위치다.

```text
worldPoint = position + R(orientation) (localPoint - localCenter)
worldPointVelocity = velocity + angularVelocity × (worldPoint - position)
```

Body ID에는 source scope, root ID와 순서에 독립적인 component content
identity를 사용한다. ID와 배열 위치는 별도로 관리한다. Geometry vars의
topology 변경이나 질량 mesh profile 변경은 새 모델이며 split/merge 뒤의
물리 identity를 자동 승계하지 않는다.

## 배치 core와 적분

수치 core는 body별 위치·속도·world 각운동량 `[body,3]`, body→world
quaternion `[body,4]`와 COM 기준 local 관성 `[body,3,3]`을 받는다.
Quaternion 순서는 wxyz다. Body별 Solver 호출이나 객체 생성 없이 배열
전체를 계산하며, 부착점 힘은 body-index 배열로 모아 합산한다.

World 각운동량을 L, local 관성을 I라고 할 때 각속도는
`omega = R I^-1 R^T L`이다. 2차 Lie midpoint는 다음과 같이 갱신한다.

```text
Rmid = Exp(h omega0 / 2) R0
Lmid = L0 + h torque0 / 2
omegaMid = Rmid I^-1 Rmid^T Lmid
R1 = Exp(h omegaMid) R0
L1 = L0 + h torqueMid
```

병진에도 같은 midpoint를 적용한다. 부착점 힘의 COM 모멘트는 각 stage의
자세에서 계산한다. 순수 토크와 world 힘은 상수이며, 중력은 실제 질량에
곱한다. 무토크 world 각운동량은 유지된다. 에너지를 정확 보존하는
방법으로 해석하지 않으며 시간간격 수렴으로 오차를 확인한다.

## 접촉과 충돌

고정/동적 강체의 실제 solid 삼각형 표면으로 접촉을 찾는다. BVH 거리와
병진·회전 속도 한계로 접근 시간을 제한하고, 접촉점의 법선 impulse와
Coulomb 마찰 impulse를 반복 계산한다. 마찰·반발 계수는 MaterialInteraction의
선택을 따르며, 생략 시 기본 동작과 수치 설정은 현재 Catalog 계약에서 확인한다.

허용오차를 넘는 초기 관통은 거부한다. 접촉 반복이 수렴하지 않거나 timestep
세분화로도 관통 허용오차를 만족하지 못하면 오류를 반환하며 실패 후보를
승인 상태로 저장하지 않는다. 접촉점 impulse 이력, 누적 마찰 소산과 관통
관측값은 continuation에 보존하고 BVH와 충돌 라이브러리 객체는 child에서
재구성한다. 강체 접촉은 변형체의 응력이나 접촉면 탄성변형을 계산하지 않는다.

## 시간창과 immutable state

첫 호출에서 모델을 준비하고 첫 시간창까지 진행한다. 모델의 질량·관성·
기준 mesh는 state의 immutable 배열로 보존하며 다음 child에서 재사용한다.
입력 state는 복사하여 읽고, 성공한 계산만 StatePatch로 반환한다.

전역 dt 격자, 시간창 끝과 최종 시각 중 가장 이른 시각까지 한 step을
계산한다. 비정수 시간창은 부분 step을 만들 수 있다. 같은 step 순서를
사용한 분할·연속 실행은 동일하며, 서로 다른 부분 step 순서에는 시간간격
수렴 기준을 적용한다. 시간 계산은 정수 tick을 사용하고, 동역학 경계
허용오차는 관측 간격과 독립적이다. 부동소수점으로 다음 시각을 표현할
수 없으면 오류로 종료한다.

출력은 초기 시각, 전역 출력 격자와 최종 시각을 보존한다. 출력 시각은
추가 내부 step을 만들지 않는다. 내부 step의 비율 a에서 다음 식으로
관측용 상태를 계산한다.

```text
z(a) = z0 + h [a k0 + a² (kMid - k0)]
R(a) = Exp(h [a omega0 + a² (omegaMid - omega0)]) R0
```

z는 위치·속도·각운동량이다. 회전 증분을 보존하므로 endpoint quaternion만
보는 보간이 잃을 수 있는 한 바퀴 이상의 회전도 과학 출력에 반영한다.
관측용 상태는 다음 step에 반영하지 않는다. History의 final scope는
마지막 출력 표본이며 native snapshot은 실제 호출 종료 상태다.

## Cell-average 출력과 시각화

같은 body 집합·시각·Box·subcell에서 질량과 운동량을 함께 누적한다.
밀도는 전체 cell 부피로 나눈 질량이고, 속도는 cell 안 물질의 질량가중
속도다. 밀도 0인 cell의 속도 0은 빈 공간의 저장 규약이다. 하나의 cell에
들어온 여러 body의 기여는 질량·운동량에 합산한다. 접촉 impulse와 관통 검사는
물리 적분 경로에서 수행하며 관측 Box나 subcell 해상도에 의존하지 않는다.

기준 물질 mesh의 pose만 변환해 내부 판정한다. 공간 처리는 제한된 ray
column chunk로 나누고 취소를 확인한다. 결과 질량을 강제로 맞추는 후처리는
하지 않는다. 관측 분할 수를 높여 질량·운동량 오차의 수렴을 확인한다.

Native BundleValue는 ID, 질량특성, 시간과 pose를 담는다. 자동
mesh-transform visualization은 packed 기준 mesh와 pose history를
같은 기존 resource·ACK 채널로 전달한다. Viewer는 배율 1로 변환하고
화면 frame 사이에 COM 선형 보간과 quaternion SLERP를 적용한다. 화면
보간은 이미 저장된 frame 사이의 표시이며 수치 출력을 다시 계산하지 않는다.

## 검증 위치

Geometry solid tests는 cavities, nested islands, 일반 관성과 정밀도 수렴을
검증한다. Rigid method tests는 독립적인 고정밀 적분 기준과 비교하여
midpoint 및 관측 보간의 2차 수렴, frame covariance와 입력 불변성을
확인한다. Solver·output·runtime tests는 분할 실행, 공유 quadrature,
보존량, provenance, 취소와 자원 해제를 검사한다. Catalog 예제는 공통
CLI build 이후 실제 child와 기록 ACK를 거치며 브라우저 harness에서
저장된 mesh 운동과 수치 Grid를 함께 표시한다.
`test_rigid_contact.py`는 일반 solid 충돌, 마찰·반발, 관통과 접촉 실패 조건을
검사하고 실제 child checkpoint 시험에서 접촉 이력의 분기·해제를 확인한다.
