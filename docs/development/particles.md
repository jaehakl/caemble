# 공통 물리량과 입자 해석 검증

DEM·SPH·MPM은 독립적인 ABI 3 CPU 패키지다. 실행 계약과 공식 예제의
정본은 Catalog SQLite이며, 이 문서는 구현 경계와 수치 검증을 설명한다.
[Solver 개발 계약](solver-development.md)과
[입자 해석 사용법](../manual/program/program-particles.md)을 함께 읽는다.

## 공통 경계

`kernel.api.quantities`는 Field와 domain 없는 Quantity 배열에 같은
QuantityKind·단위·성분 검증을 적용한다. Field의 공개 생성자는 평탄한
구조를 유지한다. 명시적인 sample 축과 6성분 대칭 Tensor도 검증한다.
Particle의 위치, ID, Material index와 생성 root의 대응은 별도로 보존한다.

입자 속성은 `QuantityArrayValue`이며 `attribute_field`는 같은 배열의
읽기 전용 view를 반환한다. ResourceStore는 Quantity를 독립적인 resource로
소유하고, 일괄 ingest에서 같은 backing array를 공유한다. 큰 배열의 mmap과
작은 배열의 child 직렬화 모두 immutable 접근을 유지한다.

독립 native Field export에도 `particle` 위치를 허용한다. typed input을 받는
child는 Field domain의 좌표·ID·재료 대응과 값만으로 해석하며 원래 Geometry나
생산 state를 조회하지 않는다. 잘못된 domain–location, 물리량·단위·성분과
입자 수는 공통 검증에서 거부한다. state와 export는 각각 lease를 가지며
마지막 소유자가 해제될 때 backing buffer를 정리한다.

호출 사이에는 준비된 물리 모델과 승인된 상태만 저장한다. DEM 접촉 이력,
SPH 밀도, MPM 변형구배와 affine 계수도 포함한다. 탐색 트리와 배경 격자
workspace는 child에서 재구성한다. 매 timestep에 Quantity 객체를 만들지 않는다.

Geometry·재료·경계·생성·적분 설정은 continuation identity에 참여한다.
관측 Box, 해상도, 표시 설정과 출력 간격은 참여하지 않는다. 전역 dt 격자와
물리 안정성 제한에 따라 적분하고 승인된 양쪽 상태에서 출력 시각을 보간한다.
시간창 경계가 dt와 맞지 않으면 부분 step이 생기므로 연속·분할 실행 비교는
동일한 내부 step 순서에서 수행한다. 소수 시간창 경계의 roundoff로 출력 tick이
빠지거나 같은 시각이 중복되지 않는 회귀도 둔다.

Box Grid는 입자 중심을 cell에 귀속시킨다. 질량과 운동량을 먼저 합산한 뒤
전체 cell 체적으로 나누어 밀도와 운동량 밀도를 만들고, 운동량/질량으로
속도를 계산한다. 빈 cell은 모두 0이다. 계산 격자나 접촉 탐색을 관측 Box로
대체하지 않는다.

## DEM

Canonical 삼각형 mesh의 내부 판정과 최근접 표면 거리를 모두 사용하여
구 전체가 들어가는 결정적 격자 배치를 생성한다. Boolean cavity는 입자로
채우지 않는다. 질량은 밀도와 구의 체적, 관성은 균질 구의 관성으로 계산한다.

쌍 힘은 같은 접촉점에 반대 방향으로 적용하며 회전 모멘트를 함께 누적한다.
법선 spring–damper는 인장을 만들지 않으며, 접선 spring 이력은 접촉 법선의
변화에 따라 회전시킨다. Coulomb 한계를 넘으면 운동 마찰로 제한하고 이력을
보정한다. 벽의 동일 표면에 속하는 삼각형과 convex edge의 같은 최근접점은
중복 접촉으로 계산하지 않는다. Boolean source가 나눈 인접한 평면도 한 접촉
표면으로 묶는다. 벽의 feature가 바뀔 때는 접촉점 이동과 법선을 확인하여
이력을 일대일로 이전하고, 오목한 코너의 동시 접촉은 별도 이력으로 유지한다.

계수는 Material 쌍마다 준비한다. 실제 적용한 모델과 계수도 state에 보존한다.
기본 모델은 frozen Catalog에서 가져오며 Solver 상수로 복제하지 않는다.
입자–입자와 입자–벽 쌍만 준비하고 벽에는 밀도 모델을 요구하지 않는다.

Symplectic Euler의 내부 간격은 법선·접선 유효질량, 강성·감쇠, 병진 및
회전 접촉점 이동량으로 제한한다. 이는 에너지의 정확 보존 방법이 아니며
무감쇠 충돌과 timestep 수렴으로 정확도를 확인한다.

## SPH

3D Wendland C2 kernel의 support는 smoothing length의 두 배다.
밀도는 연속방정식, 압력은 Tait 식으로 계산한다. 압력항은 재료 입자 쌍에서
대칭이며 점성항은 Material의 동점성이 아닌 점성계수 μ를 사용한다.
위치·속도·밀도를 explicit midpoint predictor–corrector로 함께 갱신한다.

고정 경계는 계산 domain의 축 정렬 평면이다. 실제 canonical 벽 표면의 위치,
방향과 덮는 영역을 검증한다. 반사 ghost의 압력은 중력으로 외삽하며 속도의
모든 성분을 반전하여 no-slip을 적용한다. Ghost는 공개 Particle 수나 질량에
포함하지 않는다. 주기 방향에서는 위치와 이웃 image를 함께 처리한다.
곡면 벽, 벽을 통과한 입자, 비양수 밀도와 비유한 상태는 명시적으로 거부한다.

정수압은 압력 구배와 중력의 균형으로, 채널은
`u(y) = gx y(H-y)/(2 nu)`로 검증한다. 입자 spacing과 시간간격은 별도로
정련한다. 출력 cell 평균과 입자 자체의 밀도는 정의가 다르므로
압축성 오차 평가는 Particle 밀도로 수행한다.

압력 Box Grid는 현재 위치에서 같은 cell에 귀속된 유체 입자의
`sum((m/rho)*p) / sum(m/rho)`이다. 관측 시점의 재료 밀도와 압력을 사용하며
ghost는 제외한다. `configuration: current`, `weighting: material-volume`은
물질이 있는 부분의 입자 체적 가중 평균을 뜻한다. 입자 중심의 cell 귀속에
따른 이산 관측이며 kernel 보간이나 유체 경계면의 체적 재구성은 아니다.

기존 질량밀도 `sum(m) / cellVolume`, 입자 자체의 재료 밀도 `rho`, 위의
평균 압력은 서로 다른 값이다. 빈 cell은 압력 0을 저장하고 음의 gauge
pressure도 그대로 기록한다. 같은 Box·gridShape·scope·시간 표본의 질량밀도
`> 0`을 유효영역으로 사용한다. 관측 설정이 다른 밀도와 압력을 조합하지 않는다.

## MPM

Quadratic B-spline의 27개 격자 절점으로 APIC 질량·운동량을 전달한다.
격자 힘을 적용하고 고정 절점 속도를 0으로 만든 뒤 G2P로 속도와 affine
계수를 갱신한다. 속도 구배로 `F_new = (I + dt grad(v)) F`를 계산한다.
다음 위치에서도 interpolation support가 격자 안에 있는지 commit 전에 검사한다.

Compressible Neo-Hookean 에너지 밀도는 기준 체적당 값이다.

```text
J = det(F)
W = mu/2 (tr(F^T F) - 3) - mu log(J) + lambda/2 log(J)^2
P = dW/dF
sigma = P F^T / J
currentVolume = referenceVolume J
```

격자 힘에는 기준 체적과 Kirchhoff 응력 `P F^T`를 사용한다.
출력 응력은 Cauchy 응력이다. `J <= 0`은 재료 반전 오류이며 보정하여
통과시키지 않는다. 구성식은 `methods.continuum.hyperelastic`에서 FEM과 공유하며
MPM은 접선을 요청하지 않는다. FEM의 작은 변형률 J2 경로는 별개다.

현재 변형의 음향 tensor에서 최대 파속을 구해 timestep을 제한한다. 재료
상태가 유효하지 않으면 마지막 승인 상태에서 timestep을 줄여 재시도하고,
양의 J·유한한 응답·강한 타원성이 확인된 후보만 승인한다. 고정 계산 격자
이탈은 즉시 오류다. 기준 위치는 ID에 대응하는 모델 데이터로 보존하며
기준/현재 관측의 체적 가중치는 각각 V0와 J V0다. 관측 시점의 F는 회전과
log-stretch를 보간하고 응력·밀도·에너지를 다시 계산한다.

## 검증 근거

허용오차는 각 시험에 고정한다. 다음 파일들이 재실행 가능한 근거다.

| 시험 | 검증 내용 |
|---|---|
| `test_dem_particles.py` | 이종 질량 충돌, 운동량, 감쇠, 바닥 반발, 접촉 이력, 경사면 구름과 slip |
| `test_dem_contracts.py` | 기본 접촉, 부분 모델 대체, 단일 target, Task Geometry, 벽의 밀도 생략 |
| `test_particle_final_review.py` | convex edge, Boolean 평면 경계, 오목한 코너의 독립 접촉 이력 |
| `test_particle_sph.py` | kernel 적분, 쌍 힘, 정수압, Poiseuille 공간·시간 수렴 |
| `test_particle_mpm.py` | APIC 보존과 affine 재현, 구성식 에너지 미분, 회전, 고정 격자와 수렴 |
| `test_particle_methods.py` | Boolean cavity, 보존적인 Box Grid, 출력 간격 독립성, 시간창 경계 |
| `test_particle_quantities.py` | 단위·Tensor·ID·재료 오류와 Field view 공유 |
| `test_particle_field_handoff.py` | 독립 particle Field의 실제 child 전달, 재정렬 ID, state 해제 이후 소비, 실패 rollback과 마지막 lease 정리 |
| `test_sph_outputs.py` | 현재 체적 가중 압력, 질량밀도 유효영역, 음압·빈 cell·회전 Box·scope |
| `test_particle_runtime.py` | 세 Solver 실제 child, checkpoint 분기, 실패·취소 rollback, 기록·재조회·ACK·해제 |
| `test_particle_faults.py` | 실제 Particle checkpoint 전달 중 child crash, rollback과 정상 재시도 |
| `test_particle_continuation.py` | 실제 실행 계약의 연속·분할 실행에서 모든 물리량과 DEM 접촉 이력·소산 비교 |
| `test_particle_observation_independence.py` | 실제 실행 계약에서 관측 Box·해상도·출력 간격·표시 변경의 물리 상태 독립성 |
| `test_particle_visualizations.py` (API) | attachment 저장, preflight 완료, Measurement 재조회 |
| `test_particle_database.py` (API) | 실제 PostgreSQL에서 세 Solver의 Measurement·Preflight 저장 후 새 세션 재조회 |
| `particleSets.test.ts`, `ParticleSetResult.test.tsx` | frozen 표시 계약, ID 대응, 물리 반경과 점 크기, 속성 선택 |

2026-09-15의 실제 CLI 주기 채널 결과는 256개 입자, 6 s, 3개 시간창이다.
저장된 attachment를 다시 읽어 계산한 속도 상대 L2 오차는 **3.1985%**,
기록된 입자 밀도의 최대 상대 변화는 **0.10975%**였다. 요구 기준인 5%와
1%보다 작고, 모든 입자가 두 고정 벽 사이에 남았다. 이 값은 해당 예제와
해상도의 검증 결과이며 임의 형상·재료에 대한 정확도 보증은 아니다.

브라우저 검증은 실제 로컬 결과 manifest와 attachment를 기존
`scripts/test-mesh-viewer.mjs`의 saved-result 경로에 연결한다. WebGL에서
DEM은 실제 반경의 구, SPH·MPM은 화면 크기의 점으로 확인한다. 시간 재생,
물리량·성분·ID 선택은 기존 WorkbenchViewer를 사용한다. 별도 저장 endpoint는 없다.

PostgreSQL 검증에서는 실제 CLI 결과를 기존 staging·완료 경로로 저장하고
새 DB 세션에서 Measurement와 Preflight를 각각 조회한다. ID·Material·시간·
전체 Tensor 값과 바이너리를 비교하고, 완료 후 staging 삭제도 확인한다.
2026-09-15에는 로컬 임시 PostgreSQL 17/pgvector에서 총 여섯 경로가 통과했다.
이 시험은 명시적인 로컬 DB 설정이 있을 때만 실행하며, 검증 후 임시 DB와
컨테이너를 제거했다.

부분 수정은 `python -m tests.run affected`로 검증하고, 전체 CPU 회귀는
필요한 시점에 `python -m tests.run full`로 명시적으로 실행한다.
[검사 선택·병렬 실행·보고 규약](solver-development.md#변경-영향-검사와-전체-cpu-회귀)을 따른다. Catalog의
Draft build와 canonical publish 후에는 같은 revision으로 다시 build한다.
로컬 `experiment test` 결과는 `data inspect --result`로 재조회한다.
운영 배포와 원격 실행은 이 검증 범위에 포함하지 않는다.

전체 Catalog 예제의 입력 경계는 UI 디렉터리의
`npm run test:catalog-examples`와 `npm run test:client-build:run`으로 확인한다.
전자는 모든 예제를 compile·evaluate·build하고, 후자는 브라우저 입력과
격리된 CLI worker의 입력이 같은지 비교한다. 예제 개수는 상수가 아니라
Catalog metadata와 대조한다. 2026-09-15에는 신규 여섯 예제를 포함한
28개 전체가 같은 canonical revision에서 두 검사를 통과했다.
