# 압력음향의 주파수응답, 시간응답과 표면 운동 전달

이 구현은 균질한 정지 유체의 작은 압력 변동을 선형 사면체 FEM으로 푼다.
시간응답은 같은 물리 방정식을 직교 staggered grid의 pressure–velocity
FDTD로 적분한다. 두 수치 모델은 독립적이며 기본 해석은 기존 harmonic이다.
실행 가능한 독립 관 문제와 탄성판 연계 예제, Material 계수 및 정확한 Task
문법은 SQLite Catalog에서 조회한다. 사용자는 primitive와 semantic 면을
선택하며 절점 좌표나 요소 연결을 작성하지 않는다.

## 해석별 구현 책임

`pressure_acoustics/entry.py`는 `analysis`를 읽고 선택한 실행 함수에
위임하는 ABI 3 진입점이다. 생략 시 harmonic을 선택하는 입력 기본값은
유지하며, FEM과 FDTD는 같은 수준의 독립 패키지로 구성한다.

- `harmonic_fem/`은 주파수 설정 검증, tetrahedral mesh 준비, FEM 조립과
  복소 풀이, 수치 출력 및 native 표시를 소유한다. `run.py`가 이 과정을 조립한다.
- `transient_fdtd/`는 Box 격자, 실제 표면 파형과 직접 가진, staggered
  시간 적분, restart 및 누적 기록을 소유한다. `run.py`가 한 창을 실행한다.
- 공통 `parameters.py`는 정규화된 Task·Material 값 읽기만 제공한다.
  두 해석 패키지는 서로 import하지 않으며, 실제 공통 수치 도구는 기존
  `methods`를 사용한다. 공통 매개변수 처리도 특정 해석에 의존하지 않는다.

각 패키지의 수치 모듈은 실행·출력 조립을 import하지 않는다. 공통 진입점은
선택한 해석을 해당 분기에서 import하므로 다른 해석의 실행 준비를 하지 않는다.

## 물리 규약

복소 값은 peak phasor이고 시간 의존성은 `exp(+i*omega*t)`다. 유체의
바깥쪽 법선을 `n`이라 하면 `v = -grad(P)/(i*omega*rho)`이며
`dP/dn = -i*omega*rho*(v dot n)`이다. 구조와 유체의 접합면 외향 법선은
반대이므로 가진 부호는 유체 쪽 법선으로 계산한다.
이 압력–속도 관계는 [COMSOL의 주파수영역 강도 정의](https://doc.comsol.com/6.4/doc/com.comsol.help.aco/aco_ug_pressure.05.143.html)와 같다.

체적 연산자는 `K = integral(grad(N)^T grad(N)/rho)`와
`M = integral(N^T N/(rho*c^2))`다. 양의 실수 임피던스 `Z`를 가진
경계에서는 `Bz = integral(N^T N/Z)`를 조립하여
`(K - omega^2*M + i*omega*Bz)P = -i*omega*S*Vs`를 푼다.
미지정 외부 면은 강체벽이다. 직접 지정한 속도도 유체 외향 성분을 뜻한다.
밀도와 음속은 Material의 물리 계수이고 mesh 해상도·주파수·경계 임피던스는
해석 설정이다. Material 이름으로 외부 계수를 조회하지 않는다.

## 독립 mesh 연결

표면 속도는 기준 좌표의 `tri3` mesh를 domain으로 갖는 복소 node Field다.
source의 mesh와 유체 mesh는 identity나 절점 개수가 달라도 된다. 주파수는
Hz로 정규화한 실제 값과 순서로 맞추며 암묵적으로 보간하지 않는다.

첫 전달 연산자는 동일한 평면 다각형을 덮는 비일치 삼각분할을 지원한다.
평면 좌표에서 삼각형 교집합을 구한 뒤 그 위에서 두 형상함수의 곱을 정확히
적분한다. source와 target 양쪽의 면적 coverage를 검사한다. 곡면, 틈,
부분 겹침이나 중복 coverage를 가장 가까운 면으로 투영하여 숨기지 않는다.
기하 공차는 표면 크기와 좌표의 부동소수점 정밀도를 반영한다.

`S = integral(Na^T n^T Ns)`는 호출당 한 번 조립한다. 접선 운동의 기여는
0이지만, 평균 법선 속도가 0인 공간 분포의 기여는 일반적으로 0이 아니다.
동일 연산자의 전치는 가상일 관계를 만족한다. 현재 음향 계산은 구조 운동을
외부 가진으로 취급하므로 유체 압력이 구조에 되먹임되는 모델은 아니다.

## 기록과 표시

계산은 complex128로 수행하고 native Field 전달은 complex64를 사용한다.
수치 Output은 기존 일곱 축 Box Grid의 실수 진폭·위상 채널이며 압력 단위는
Pa다. Native mesh 표시와 표면 export는 Calculation 및 Prediction 입력에
포함되지 않는다. Solver 사이의 실행 순서는 `simulate.py`가 소유한다.

Native 표시는 선택한 주파수에서 `Re(P*exp(i*phase))`를 보여 준다. 이는
진폭이나 RMS 값이 아니라 부호 있는 순간 압력이다. 구조 변위와 응력도
동일한 규칙으로 복원하며 같은 invocation·주파수·위상의 변위를 사용한다.

Calculation 예제는 관측점의 RMS 압력 `abs(P)/sqrt(2)`와
`20*log10(abs(P)/(sqrt(2)*20e-6))`의 SPL을 계산한다. 압력이 0이면 유한한
SPL이 정의되지 않으므로 예제는 오류를 표시한다. 복소 압력/힘 응답은 최종
Calculation의 실수 결과 계약에 맞춰 실수부와 허수부를 각각 보존한다.
각 예제의 이름·설명에 출력 단위를 명시한다.

## 시간영역의 격자와 경계

Transient는 하나의 축 정렬 Box와 균질한 정지 유체를 지원한다. canonical
primitive와 transform/instance를 해석하며 축 교환·반전·이동은 허용한다.
최종 축이 비스듬하거나 shear가 있는 형상, Boolean, 곡면은 거부한다.
지원하지 않는 형상의 bounding box나 voxel 근사를 계산 영역으로 대신 쓰지
않는다. `GeometryService`의 표면 mesh는 semantic provenance 확인에만
사용하며 tetrahedral 체적 mesh는 만들지 않는다.

각 축 길이 `L_j`와 목표 간격 `h`에서 `N_j=ceil(L_j/h)`,
`dx_j=L_j/N_j`로 실제 Box 길이를 정확히 덮는다. NumPy 축 순서는 xyz이며
압력 `p^n`의 shape는 `[Nx,Ny,Nz]`, 속도 `vx^(n-1/2)`,
`vy^(n-1/2)`, `vz^(n-1/2)`는 각각 `[Nx+1,Ny,Nz]`,
`[Nx,Ny+1,Nz]`, `[Nx,Ny,Nz+1]`다. 압력은 셀 중심, 각 속도 성분은
해당 방향의 셀 면에 있다. 배열 속도는 world 축의 증가 방향이고, 경계
입력은 유체 외향 법선 기준이다. 따라서 x 최소 면의 외향 속도 `w`는
배열 `vx[0]`의 음수다.

내부 면은 `v^+=v^- - dt*grad(p^n)/rho`, 다음 압력은
`p^(n+1)=p^n-rho*c^2*dt*div(v^+)`로 계산한다. 초기 공기는
`p^0=0`, `v^(-1/2)=0`이며 첫 pressure step은 `[0,dt]`에 걸친
지정 경계 속도의 평균을 사용한다. 초기 구조 속도가 0이 아닌 경우의
경계 불연속은 실제 입력 그대로 전달하고 acoustic ramp로 감추지 않는다.

미지정 경계는 유량 0인 강체벽이다. 한 rule 안의 중복 semantic alias는
같은 물리 면을 한 번만 포함하며, 서로 다른 rule이 같은 면을 점유하면
거부한다. 직접 속도와 구조 표면 속도는 해당 외부 면의 flux를 지정한다.
이 외부 면에 내부 gradient 갱신을 적용하거나 source를 pressure에 한 번
더 더하지 않는다.

저항 경계에서는 인접 pressure cell과 실제 Box 면 사이의 반 셀 거리를
보존한다. 면적 `A`, 법선방향 간격 `h`, 외향 속도 `w`에 대해
`m=rho*A*h/2`, `r=Z*A`로 두고 다음 국소 대수식으로 갱신한다.

```text
(m + dt*r/2) w^(n+1/2)
    = (m - dt*r/2) w^(n-1/2) + dt*A*p_cell^n
```

이는 `m*dw/dt+r*w=A*p_cell`의 저항 항을 시간 중앙에서 평가한 것이다.
`Z>0`는 실제 경계의 `p_boundary=Z*w`이며, 반 셀 관성은 pressure cell과
경계 사이의 운동량 이산화다. `p_cell/Z`를 과거 시각의 경계 속도로 바로
대입하지 않는다. edge/corner의 여러 경계는 각각의 실제 면에서 계산한다.
`Z=rho*c`는 정상 입사의 matched 종단이며 모든 각도·모드의 무반사 경계나
자유공간 PML을 의미하지 않는다.

## 이산 에너지와 안정성

속도 half tick에서 아래 수정 에너지를 사용한다. 내부 face의 질량은
`m_f=rho*A_f*h_f`, 저항 경계 face에서는 그 절반이다. 강체·지정 속도
face는 kinetic sum에서 제외한다. `V_c`는 실제 셀 체적이다.

```text
E^(n+1/2) = 1/2 sum_f m_f (v_f^(n+1/2))^2
           + 1/2 sum_c V_c/(rho*c^2) p_c^n p_c^(n+1)

E^(n+1/2) - E^(n-1/2)
  = -dt sum_resistive Z*A ((w^(n+1/2)+w^(n-1/2))/2)^2
    -dt sum_prescribed A*p_cell^n*(w^(n+1/2)+w^(n-1/2))/2
```

각 momentum 식에 평균 face velocity를 곱하고 연속한 두 pressure 식을
더하면 내부 face의 일이 상쇄되어 이 수지가 성립한다. 무가진 조건에서는
첫 항이 0 이하이고, 두 번째 항은 지정 경계가 유체에 가한 외부 일이다.
구조에 대한 acoustic 반력은 계산하지 않으므로 결합된 구조·유체 전체의
에너지 보존을 주장하지 않는다.

무가진 에너지의 cross-time pressure 항을 완전제곱으로 정리하면 velocity
질량행렬에서 `dt^2/4`에 비례하는 공간 연산자 항을 뺀 형태를 얻는다.
직교격자와 반 셀 경계의 방향별 최대 고유값 상한은 `4*c^2/dx_j^2`다.
따라서 다음 고정 CFL 여유는 모든 양의 실수 저항에서 양의 에너지와
비증가 수지를 보장한다.

```text
dt <= 0.9 / (c * sqrt(dx^-2 + dy^-2 + dz^-2))
```

이 유도는 [Bilbao 등, 2016의 에너지 기반 경계 설계 원칙](https://www.pure.ed.ac.uk/ws/files/22154168/fv_genimp_final_r3.pdf)을
참고한 이 구현의 pressure–velocity 이산화다. 논문의 모든 경계 모델을
구현한 것은 아니다. `discreteEnergy` observation은 마지막 velocity
half tick, 즉 `time-dt/2`의 위 수정 에너지이며 다른 시각의 p와 v를
단순 제곱한 물리 에너지와 구분한다. 강체벽의 무가진 보존, 저항 경계의
손실, 소스의 외부 일과 pulse 종료 후 감쇠를 각각 검사한다.

## 실제 구조 파형과 고정 시간 격자

새 transient surface artifact는 기준 형상의 외부 tri3 mesh와 실수
Cartesian node velocity `[node,time,xyz]`, 실제 초 단위 시간축을
포함한다. Consumer는 reference configuration, `solved-window`, 수렴
완료, source model/domain identity 및 자신의 checkpoint와 일치하는
구간을 확인한다. 초기 한 프레임, 미수렴 trial, 기존 `fea.motion`의 다음
구간 예측은 acoustic 실제 가진으로 사용하지 않는다.

면별 연산자는 `G[a,3*s+j]=integral_face(N_s*n_fluid[j])`다. 독립적인
구조 tri3와 acoustic quad face의 교집합에서 적분하고 양쪽 coverage를
검사한다. 그 결과 `Q=G*V`, `w=Q/A`를 얻는다. FEM의 target node load와
구별되는 grid face flux이며, 접선 성분은 기여하지 않아도 전체 평균 0인
국소 운동의 분포는 보존한다. Source와 target의 domain identity가 같을
필요는 없다.

파형은 실제 시간축 위의 구간별 선형 함수다. 공간 전달을 source 표본에
한 번 적용한 뒤 각 acoustic `[t_n,t_(n+1)]` 구간의 정확한 적분을
`dt`로 나누어 사용한다. Source 표본 경계를 지나는 step도 조각별로
적분한다. 검증된 창 끝점의 부동소수점 덧셈 오차만 작은 공차 안에서
경계에 맞추고, 실제 gap·overlap·구간 밖 외삽은 거부한다. 이 적분은
해당 piecewise-linear 함수의 유체 체적을 보존하며 원래 구조의 고주파
aliasing까지 제거하지는 않는다.

직접 가진은 signed peak velocity `A`의 Hann tone burst다. 시작 시각을
뺀 `s`에 대해 `A*sin(pi*s/T)^2*sin(2*pi*f*s)`를 `[0,T]`에서
사용하고 support 밖은 0이다. 시작과 끝의 값 및 첫 미분은 0이며,
step 평균은 삼각함수의 정확한 정적분으로 계산한다. 별도 impulse나
전 주파수 대역의 균일 가진으로 간주하지 않는다.

시간 격자는 명시적 `dt`와 정수 전체 step 수로 한 번 정한다. 한 호출은
정수 `windowSteps`만큼 진행하고 마지막 호출은 남은 정수 step만 계산한다.
창마다 dt를 역산하거나 마지막 짧은 leapfrog step을 삽입하지 않는다.
모든 시각은 `step*dt`이며 원점은 같은 run의 0초다. 창 길이와 출력
stride는 물리적 restart identity를 바꾸지 않는다.

State는 task별 `restart`와 `recording`으로 분리한다. Restart에는 schema,
물리 모델 identity, 원점·dt·step, pressure와 세 staggered velocity를
보존한다. 새 child는 입력 배열을 한 번 복사해 계산하며 기존 checkpoint를
제자리 변경하지 않는다. 기록은 요청한 Box 표본의 불변 chunk만 누적한다.
첫 acoustic 호출은 정지 공기에서 첫 창을 계산하므로 구조의 초기화 전용
호출과 다르다. 같은 run의 live checkpoint에서 이어하기·재계산을 지원하며
다른 run이나 worker 재시작 뒤의 영구 복원 기능은 아니다.

## 시간 이력의 기록

관측점도 기존 Box Grid 중심 표본이다. 계산 grid와 독립적인 회전 출력
Box·singleton 축·영역 밖 0 처리를 그대로 사용한다. 실제 Pa의 부호를
보존하는 float64 이력을 기존 일곱 축으로 기록한다. 매 output의 정수
stride에 대해 t=0과 전역 step 배수만 남기고, stride 밖의 마지막 창
끝점을 추가하거나 다른 시각의 값에 요청 시각 label을 붙이지 않는다.

같은 Task의 continuation에서는 output key, Box 위치·크기·회전·표본 수,
stride를 유지한다. 물리 checkpoint identity와 별도로 기록 정의를
보존·검사하여, 같은 shape의 다른 Box로 이전 이력의 위치를 바꾸거나
새 output에 존재하지 않는 과거 표본을 꾸미지 않는다. 기록 정의를 바꾸어
비교하려면 초기 state에서 다시 실행한다. 새 실행의 출력 설정 차이는
pressure·velocity 전진에 영향을 주지 않는다.

요청 output은 매 호출 누적 artifact로 반환하지만 전체 체적의 매-step
history를 쌓지는 않는다. 프로그램은 마지막 호출 결과를 한 번 기록할
수 있다. 출력 stride를 크게 하면 원시 파형의 고주파 정보가 빠질 수
있으며, 오디오용 antialias filter나 WAV 변환을 제공한다고 주장하지 않는다.
기존 Box Grid 표시를 사용하고 별도의 acoustic native animation 계약은
추가하지 않는다. 실행 전 progress에는 cell 수, 전체 step 수, 실제 dt,
요청된 전체 출력 값 수를 제공한다.

## 검증

Matched tube의 기준해는 `P(x)=rho*c*V0*exp(-i*k*x)`다. 세 mesh 단계의
복소 압력 오차와 주파수 표본 사이의 재구성 오차를 비교한다. 선형 tet4의
consistent mass는 체적 `V`에 대해 `V*(ones+I)/(20*rho*c^2)`이며 이를
독립적인 요소 회귀로 검사한다.

Peak phasor의 입력 power는 `-Re(P^H*S*Vs)/2`, 저항 경계의 출력 power는
`Re(P^H*Bz*P)/2`다. 같은 조립행렬로 계산한 수지는 이산 방정식에서도
성립하므로 이것만으로 공간 정확도를 주장하지 않는다. 복소 해석해 오차를
별도로 확인하고 반사성 경계의 공진 부근에서도 mesh를 세분화한다.
손실 없는 특이계에 감쇠나 작은 강성을 자동으로 더하지 않는다.

검증은 [Solver 개발 절차](solver-development.md)의 공개 CLI 빌드와 실제
child 실행을 따른다. 서로 다른 child 사이의 표면 Field 전달, 기록·표시 ACK,
취소와 실패 rollback, 명시적 해제 이후 resource 정리까지 포함한다.

실제 시험 범위, 수렴 수치와 미검증 항목은
[압력음향 시간응답 검증 보고서](pressure-acoustics-validation.md)에 정리한다.
