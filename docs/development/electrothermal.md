# 다재료 전기열과 준정적 열변형

전기와 열은 같은 canonical tet4 assembly에서 계산한다. 전기는 선택한 도체의
자유도만 사용하고, 열은 도체와 절연막·기판을 함께 사용할 수 있다. 현재 범위는
상수 등방성 열전도율, 상수 또는 온도 의존 등방성 전기전도율과 정상·비정상
열 해석이다. 재료 tensor의 기존 저장 계약은 유지하며, 이방성 전도 tensor는
명시적으로 거부한다.

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

연결한 Task는 전체 assembly의 root 선택과 mesh 설정을 동일하게 사용한다. 활성
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

기본적으로 맞닿은 재료는 공통 절점으로 완전 열접합된다. 명시한 유한 열저항
계면에서만 온도 자유도를 분리한다. 온도 전달은 원본 요소와 각 요소의 네 절점,
좌표·재료 대응을 확인하므로 같은 원본 절점의 양쪽 온도를 평균하지 않는다.
구조의 기계적 접합은 이 온도 분리와 독립적이다. 틈이 있는 물체를 연결하지 않는다.

공통 assembly 전달 method는 물리량에 관계없이 scalar 값의 요소·절점 대응과
단위 변환을 제공한다. 분리 계면은 요소별 네 절점값으로 보존하며, 온도라는
QuantityKind와 K 단위를 요구하는 책임은 DC·Structural 호출부에 있다.

적층 영역의 점·모서리 접촉은 면 접합으로 해석하지 않고 오류로 처리한다. 각
전기 연결 성분에는 기준 전위가 필요하다. 정상 Heat의 각 연결 성분에는 고정온도
또는 양의 Robin 교환이 필요하며, 비정상 Heat는 양의 열용량으로 단열 성분의
온도를 결정할 수 있다.

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

얇은 적층에서 큰 전도 항끼리 상쇄되면 float64 행렬 곱의 반올림 오차가
열원보다 커질 수 있다. DC·Heat는 보정된 내적과 두 성분의 해를 사용하는
반복 개선으로 원래 방정식의 잔차를 검사하고, 반력과 기울기를 계산한 뒤
native 값을 float64로 내보낸다. 잔차 허용오차나 물리 두께를 완화하지 않는다.
내적은 [Ogita·Rump·Oishi의 Dot2](https://doi.org/10.1137/030601818)를 따른다.

직접 해법이 기본이며, 큰 양의 정부호 문제에는 CG-AMG를 명시적으로 선택할 수
있다. Scalar 문제는 상수 모드, 구조는 구속 후의 병진·회전 강체 모드를 사용한다.
얇은 층의 강한 결합을 구분하는 대칭 강도 기준과 에너지 최소화 보간은
[PyAMG의 smoothed aggregation](https://pyamg.readthedocs.io/en/latest/generated/pyamg.aggregation.html)을
사용한다. 전처리된 잔차와 별개로 원래 방정식의 상대 잔차를 검사한다.
구조 AMG 계층 구성에서 메모리 할당이 실패하면 실패한 임시 배열을 해제한 뒤
float32 전처리로 한 번 재시도한다. 물리 행렬, CG 벡터와 최종 잔차는 float64를
유지한다. 재시도도 원래 방정식의 같은 허용오차를 만족해야 하며, 메모리 부족이나
미수렴이 계속되면 오류로 종료한다.
정적 열탄성은 요소 행렬·기울기·응력 복원을 구간별로 처리하며 질량행렬을
만들지 않는다. CG 경로는 구속된 자유도를 조립 중 제거하고, 가능한 경우 절점의
세 병진 성분을 희소 블록으로 유지한다. 기계적 반력은 같은 요소 내부력에서 복원한다.

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
소유한다. 전압과 연속 치수 Vars로 형상을 다시 빌드해 비교한다. 상수 물성 정상
기준, 온도 의존 저항률 피드백, 펄스 가열·냉각 예제는 같은 형상을 사용한다.
기본 예제에는 공기 대류·복사 손실이나 유한 계면 열저항을 추가하지 않는다.
열변형은 아래의 단방향 정적 연결로 제공한다.

## 정상 피드백과 계면 열저항

온도 의존 저항률은 기준 저항률과 기준온도, 선형 온도계수로 계산한다.
유효 온도 범위 밖의 값과 비양수 저항률은 오류이다. 전도율은 요소의 P1 온도를
적분점에서 평가하고, 전기행렬과 cell-average Joule 발열에 같은 적분을 사용한다.
Frozen Material 계수를 반복 중에 덮어쓰지 않는다.

반복은 예제의 simulate.py가 소유한다. Heat는 원래 Heat 해와 입력 추정값의 차이,
완화된 다음 추정값과 수렴 관측치를 제공한다. 완화 전 오차와 선형 잔차·전력
수지를 확인한 뒤, 완화하지 않은 추정값으로 한 번 더 계산하여 최종 DC·Heat 해의
일관성을 확인한다. 미수렴을 완료 결과로 기록하지 않는다.

계면 법칙은 MaterialInteraction에 두고 Task에서 실제 양쪽 Surface를 선택한다.
정합적인 공통 면에 양쪽 온도차에 비례하는 교환을 조립한다. 분리된 두 온도는
각 재료의 구조 적분점에 그대로 전달된다. 계면 교환은 전체 열수지에서 상쇄된다.

## 펄스와 수락한 시간 이력

Heat의 명시적 시간 격자와 초기온도가 물리 시간을 정의한다. 양의 상수 밀도·비열,
일관된 tet4 열용량행렬과 backward Euler를 사용하며 시간 단계는 펄스 전환 시각에
맞춘다. Heat가 내보낸 typed step-control로 DC가 이름 있는 단자의 전위를 평가한다.
완료된 시간 격자의 끝 제어는 다음 단계 입력으로 사용할 수 없다.

한 단계의 모든 전기열 후보는 같은 수락 상태에서 출발한다. 후보가 수렴하면
Structural이 해당 온도의 정적 평형을 계산한다. 반복 횟수는 물리 시간이나 구조
동역학의 시간 적분이 아니다. 실패한 후보는 해제하며 자동 시간 간격 재시도는 없다.
초기온도, 물성 기준온도, 주변온도, 구조의 무응력 온도는 각각 명시한다.

DC 이력은 각 구간 끝에 그 구간의 구동값을 기록한다. Heat와 Structural은 초기
시점도 포함한다. 마지막 수락 시점에 누적한 7축 Box Grid를 한 번씩 기록하고,
자동 변형 visualization도 수락한 변위만 포함한다. 열수지는 입력 열량과 저장
열에너지 증가·외부 방열량으로 확인한다. 응답시간 Calculation은 첫 가열의 정상
피드백 온도상승 90%와 첫 냉각 시작 온도상승의 10% 도달을 선형 시간 보간한다.
출력에는 유효성 값이 함께 있으며, 미도달을 0초 응답으로 해석하지 않는다.

## 정적 열변형

현재 공식 microheater 예제는 짧은 로컬 검증을 위한 소형 적층 브리지이다.
두 Si 장착부 사이의 SiN 고체에 단일 Pt 발열띠와 Au 패드를 배치하며, 전압과
발열띠 폭을 바꿀 수 있다. 기존 대형 프레임·구불구불한 패턴의 정련 결과를 이
소형 예제의 수렴 근거로 사용하지 않는다. 막과 금속의 물리 두께를 유지한 채
소형 형상 자체에서 공간·두께 방향을 검증한다. 펄스 예제는 짧은 한 번의
가열·냉각 구간이며, 그 안에서 도달하지 않은 응답시간은 유효하지 않은 값이다.

정상 microheater는 DC → Heat → Structural을 순서대로 실행한다. Heat의 native
절점 온도(K)를 Structural의 temperature 입력으로 전달하며, 기록용 Box Grid는
연성 입력으로 사용하지 않는다. 구조도 같은 전체 assembly와 적층 mesh를 사용하고
모든 실제 재료 계면을 명시적으로 bonded 처리한다. 프레임 장착면의 병진 변위만
고정하며 가열판과 지지대는 자유롭게 변형한다.

Material의 상수 scalar 선팽창계수와 Task 영역별 무응력 온도를 구분한다.
무응력 온도를 Heat의 고정온도나 Material의 다른 기준온도에서 추측하지 않는다.
온도 입력과 열팽창 영역 설정은 함께 사용한다. 적용하지 않은 영역에는 열변형률을
추가하지 않는다. 현재 열연성은 등방성 또는 직교이방성 선형 탄성 tet4 solid의
작은 변형 정적 해석만 지원하며, 열팽창 자체는 등방성이다.

각 적분점에서 `epsilon_th = alpha (T - T_sf) I`를 보간하고
`sigma = C (epsilon - epsilon_th)`를 사용한다. 내부력·반력·응력·단면력과
탄성에너지는 같은 탄성변형률에 기반한다. 에너지는 열하중을 뺀 변형률의
이차형식이며 `u^T K u / 2`로 대체하지 않는다. 온도 입력이 없으면 기존 기계
해석 경로를 사용한다. 서로 다른 assembly와 누락된 온도 영역은 거부한다.

SiN 가열판 윗면의 최대 절대 면외 변위와 뒤틀림을 native P1 해에서 기록한다.
뒤틀림은 관측 Box로 자른 기준 평면에서 면적 가중 최소제곱 평면을 제거한
변위의 최대–최소 차이이다. 응력 지표는 가열판 중앙 80%와 각 지지대 길이 중앙
50% 영역의 체적 가중 RMS von Mises 응력이다. 선형 응력의 제곱을 적분한 후
제곱근을 취하며, 관측 grid의 표본 평균이나 날카로운 고정부의 최대값이 아니다.
Box Grid 응력은 관측점 온도로 평가하고, 표시용 native cell 응력은 체적 평균이다.

형상과 물리적 층 두께를 유지한 공간·두께 정련으로 굽힘도 별도 검증한다.
tet4의 굽힘은 전기·열보다 더 조밀한 mesh가 필요할 수 있다. 예제 물성은
개발 가정이며 실측 박막 계수·제조 잔류응력과 같지 않다. 열좌굴·대변형·소성·
접촉 열연성·구조 동역학·변형 형상의 전기열 피드백은 포함하지 않는다.

큰 선형 열탄성 mesh는 조립과 응력·에너지 복원을 chunk로 수행하고 질량행렬을
조립하지 않는다. 직접 해법이 기본이며 정련용 양의 정부호 문제에는 명시적으로
AMG 전처리 CG를 선택할 수 있다. 구조에는 구속을 반영한 강체 모드, scalar 문제에는
상수 모드를 사용한다. 수렴은 원래 방정식의 상대 잔차로 판정한다.

## 검증 소유권과 이관

- `tests/test_scalar_fem.py`: 직렬·병렬 저항, 적층 열저항, 표면 경계, 전력
  보존, 얇은 층과 native 요소 대응.
- `tests/test_microheater.py`: 공식 예제의 전압·선폭 변화, 공간·두께 방향
  연속 정련의 2% 기준, 실제 child, ACK와 취소·실패 정리.
- `tests/test_structural_thermal.py`: 자유·구속 팽창, 비균일 온도의 에너지 미분,
  이종재료 굽힘 정련, native 온도 대응과 관측 grid에 독립적인 뒤틀림·응력 적분.
- `tests/test_electrothermal_feedback.py`: 독립 저항–열저항 해, 계면 온도 점프,
  일관된 열용량의 RC 가열·냉각, 시간 수렴, 후보와 수락 상태의 분리.
- `tests/test_electrothermal_interface_child.py`: 유한 열저항 계면의 실제 Heat →
  Structural 전달과 cache 유무 일치.
- `tests/test_electrothermal_runtime.py`: 실제 세 child의 수락 이력, 수치·변형
  visualization ACK, 미수렴·취소 시 state와 mmap 정리.
- `tests/test_actual_solver_chain.py`, `tests/test_coordinator_solver_chain.py`:
  서로 다른 child 사이의 공통 mesh cache와 typed artifact 전달.
- `tests/test_geometry_volume_mesh.py`와 기존 소비자 검사: Structural 등
  공통 Geometry·mesh 소비자의 회귀. 온도 없는 기존 Structural 해석도 검사한다.

Fiber Bundle과 전기열 notched-bar도 FEM 계약을 사용한다. Fiber Bundle은 단자에서
가닥 중심을 분리하고 패드와 체적으로 겹치게 하여 거의 접하는 Boolean 접합의
미세한 쐐기를 제거했다. notched-bar는 원래 형상에 적층 mesh를 적용한다. 제거된 voxel Solver
버전으로 작성한 Experiment는 자동 변환하지 않는다. 새 Catalog 예제를 기준으로
명시적으로 이관하고 다시 빌드해야 한다. 다른 Solver가 사용하는 공통 structured·
finite-volume 코드는 유지한다. 검사 선택은 `python -m tests.run affected --list`로
확인하고, focused/affected와 필요한 quick을 사용한다. Full 검증은 별도 요청이
있을 때만 수행한다.
