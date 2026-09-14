# 주파수영역 압력음향과 표면 운동 전달

이 구현은 균질한 정지 유체의 작은 압력 변동을 선형 사면체 FEM으로 푼다.
실행 가능한 독립 관 문제와 탄성판 연계 예제, Material 계수 및 정확한 Task
문법은 SQLite Catalog에서 조회한다. 사용자는 primitive와 semantic 면을
선택하며 절점 좌표나 요소 연결을 작성하지 않는다.

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
