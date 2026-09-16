# 정상 다재료 전기열 해석

전기와 열은 같은 canonical tet4 assembly에서 계산한다. 전기는 선택한 도체의
자유도만 사용하고, 열은 도체와 절연막·기판을 함께 사용할 수 있다. 현재 범위는
상수 등방성 전기전도율·열전도율과 정상 해석이다. 재료 tensor의 기존 저장
계약은 유지하며, 이방성 tensor는 명시적으로 거부한다.

공개 계약과 실행 예제는 canonical SQLite Catalog에서 조회한다. 이 문서는
Catalog의 계수·메서드 정의를 복제하지 않는다.

```powershell
.\caemble.cmd doctor
.\caemble.cmd agent guide experiment
.\caemble.cmd catalog search microheater
.\caemble.cmd experiment init .work/my-microheater --example steady-microheater
.\caemble.cmd experiment build .work/my-microheater --vars-mode nominal --out .work/microheater-input
.\caemble.cmd experiment test .work/microheater-input --out .work/microheater-result
```

## Assembly와 native 전달

두 Task는 전체 assembly의 root 선택과 mesh 설정을 동일하게 사용한다. 활성
재료 선택은 mesh 생성 뒤 수행한다. 영역별 크기 제어와 평면 적층 경로가 공통
Geometry service에 있으며, 적층 경로는 단면의 모든 재료 경계를 함께 분할하고
각 물리적 높이 구간을 나눈 뒤 정합적인 삼각기둥을 tet4로 분할한다. 실제 금속과
절연막의 두께를 늘려서 mesh를 만들지 않는다. 이 경로는 지정한 축에 평행하거나
수직인 면으로 이루어진 계단형 extrusion에 한정한다. 일반 형상은 기존 체적
mesher를 사용한다.

원본 assembly identity, 절점 번호, 요소 번호와 재료 영역 대응은 활성 부분
영역에도 남는다. DC cell-average 발열을 열 영역에 전달할 때 원본 요소 번호로
삽입하고 나머지 요소에는 0을 넣는다. 따라서 체적 적분한 총전력을 보존한다.
같은 배열 크기만으로 연결하지 않으며, 다른 assembly 또는 다른 connectivity,
좌표·재료 대응은 거부한다. 이 연결에는 비정합 mesh 보간이 없다. Native 발열은
W/m³, native 절점 온도는 K이다.

맞닿은 재료는 공통 절점으로 완전 열접합된다. 틈이 있는 물체를 연결하지 않는다.
적층 영역의 점·모서리 접촉은 면 접합으로 해석하지 않고 오류로 처리한다. 각
연결 성분에 기준 전위, 고정온도 또는 양의 Robin 교환이 있어야 한다.

## 수치식과 부호

공유 scalar FEM은 tet4 형상함수·기울기, 확산행렬, 체적·삼각형 표면 적분,
희소 조립과 제약 선형 해법만 제공한다. 재료 선택, 단자와 열 경계의 의미는
각 Solver의 domain/formulation이 소유한다.

DC는 `J = -sigma grad(phi)`, `q = grad(phi) · sigma grad(phi)`를 사용한다.
요소 발열과 전기 조립행렬은 동일한 P1 기울기를 사용한다. 단자 전류는 해당
전위 자유도의 반력 합이며 **물체 안으로 들어오는 방향이 양수**이다. 입력
전력은 모든 단자의 `V I` 합이다. 단자는 축·단면의 위치가 아닌 이름과 canonical
Surface 선택으로 지정한다.

Heat의 지정 열유속과 방열량은 **물체 밖으로 나가는 방향이 양수**이다.
Robin 경계는 `h (T - Tambient)`를 일관된 삼각형 mass matrix로 조립한다.
고정온도 경계의 방열량은 원래 조립 방정식 반력의 음의 합으로 계산한다.
지정하지 않은 외부 경계는 단열이다. 정상 상태에서 열원 적분과 전체 방열량이
같아야 한다. 기준 문제는 상대 잔차 1e-8, 정규화한 전력 불일치 1e-6으로 검증한다.

## 관측과 microheater

수치 기록은 기존 7축 Box Grid이다. 전위·온도는 native P1 해를 보간하고
전류밀도·발열은 cell field에서 표본화한다. 고체 밖은 0이며, 온도와 함께
유효 고체 영역 mask를 기록한다. 평균·최고온도는 관측 Box와 고체의 교차 영역에
대한 native 체적 적분·선형장 극값이다. 관측 grid의 해상도로 평균이나 최고값을
추정하지 않는다. 단자 전류·입력 전력·전체 방열량의 Box는 기록 컨테이너이며
공간 필터가 아니다.

공식 microheater는 Silicon 프레임, Silicon nitride 가열판·지지대, Platinum
meander와 별도의 Gold 패드로 구성된다. 기본 열경계는 프레임 장착면의 고정온도와
나머지 외부 면의 단열이다. 재료 계수의 개발 가정과 출처는 예제의 material.tsx가
소유한다. 전압과 연속 치수 Vars로 형상을 다시 빌드해 비교한다. 공기 손실,
복사, 온도 의존 물성, 전기열 반복, 계면 열저항, 열용량·펄스·시간 이력과
열변형은 제공하지 않는다.

## 검증 소유권과 이관

- `tests/test_scalar_fem.py`: 직렬·병렬 저항, 적층 열저항, 표면 경계, 전력
  보존, 얇은 층과 native 요소 대응.
- `tests/test_microheater.py`: 공식 예제의 전압·선폭 변화, 공간·두께 방향
  연속 정련의 2% 기준, 실제 child, ACK와 취소·실패 정리.
- `tests/test_actual_solver_chain.py`, `tests/test_coordinator_solver_chain.py`:
  서로 다른 child 사이의 공통 mesh cache와 typed artifact 전달.
- `tests/test_geometry_volume_mesh.py`와 기존 소비자 검사: Structural 등
  공통 Geometry·mesh 소비자의 회귀. Structural 공개 계약은 변경하지 않는다.

Fiber Bundle과 전기열 notched-bar도 FEM 계약을 사용한다. Fiber Bundle은 단자에서
가닥 중심을 분리하고 패드와 체적으로 겹치게 하여 거의 접하는 Boolean 접합의
미세한 쐐기를 제거했다. notched-bar는 원래 형상에 적층 mesh를 적용한다. 제거된 voxel Solver
버전으로 작성한 Experiment는 자동 변환하지 않는다. 새 Catalog 예제를 기준으로
명시적으로 이관하고 다시 빌드해야 한다. 다른 Solver가 사용하는 공통 structured·
finite-volume 코드는 유지한다. 검사 선택은 `python -m tests.run affected --list`로
확인하고, focused/affected와 필요한 quick을 사용한다. Full 검증은 별도 요청이
있을 때만 수행한다.
