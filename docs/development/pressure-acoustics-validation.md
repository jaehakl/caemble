# 구조 표면 시간응답과 음향 FDTD 검증 기록

2026-09-14, 기준 커밋 `19f61f966d19cc8d5fd4fb0d63243b05f46eb3ae`에서
추가한 단방향 시간응답의 로컬 검증이다. 수치 규약과 경계 에너지 유도는
[압력음향 개발 문서](pressure-acoustics.md)에 있다. 실행 가능한 예제와
공개 Solver 계약의 정본은 SQLite Catalog이며 이 문서는 측정 결과다.

## 환경과 실행 범위

Windows 11 Pro 10.0.26200, Intel Core i9-12900K(16 core/24 thread),
Python 3.12.9, NumPy 2.4.6, SciPy 1.18.1, Netgen 6.2.2606,
pytest 9.1.1, Node 24.19.0에서 CPU float64로 검증했다.
실제 runtime child, Catalog 공개 CLI build/test와 로컬 ACK 처리를 포함한다.
배포, 원격 Launcher 실행, 브라우저에서의 시각 검수, GPU 실행은 포함하지 않는다.

## 해석 패키지 리팩토링 후 재검증

FEM을 `harmonic_fem`, FDTD를 `transient_fdtd`로 분리하고 공통 진입점은
해석 선택과 위임만 수행하도록 정리한 뒤 CPU 전체 회귀를 다시 실행했다.
**746개 시험과 하위 시험 2개가 모두 통과**했으며 실행 시간은 1454.65 s다.
CUDA 시험 3개는 선택하지 않았다. 이 실행에는 공개 CLI build, 모든 공식
예제의 실제 child와 ACK, 형상 변수 변경, 실패·재시도·취소 및 자원 정리가
포함된다. E2 전체 1024 step 시험은 745.033 s에 통과했다.

옮긴 FEM 파일 6개의 계산 본문은 import와 별도로 이동한 공통 매개변수 함수를
제외한 AST 비교에서 동일했다. 집중 시험의 공간·시간 수렴, FEM 비교, 반사
관련 기록 수치 8개도 아래 기능 추가 시 결과와 정확히 같았다. 공통 진입점의
단독 import가 어느 해석 패키지도 미리 로드하지 않는 것을 확인했다.
문서 시험 4개와 CLI 빌드·doctor·diff 검사를 통과했으며 ABI 진입점,
Solver 버전, Catalog revision과 SQLite 파일 SHA-256은 변경하지 않았다.
새 회귀 결과는 `.local/acoustic-refactor-cpu.xml`, 집중 시험 결과는
`.local/acoustic-refactor-focused.xml`에 있다.

## 기능 추가 시 검증 결과

기능 추가를 완료할 때 CPU 시험 **740개 모두 통과**했다. 먼저 E2 전체 실행과 새 child 수명
시험을 분리한 회귀 724개를 실행했고, 최종 수정을 반영한 집중 시험 85개,
축 정렬 시험 16개, 형상 변수 시험 1개, 수명 시험 2개, E2 전체 실행
시험 1개를 추가 실행했다. 중복과 삭제된 시험을 제외하고 최종 수집 목록의
740개 test ID마다 성공 결과가 있는지 JUnit과 대조했다. CUDA 시험 3개는
선택하지 않았다. Catalog 시험 24개 및 하위 시험 10개, UI·문서 시험
8개도 통과했다. 아래 T1–T12 항목은 모두 이 실행 결과에 포함된다.

정본 Catalog의 활성 버전은 `structural-mechanics@6.1.0`과
`pressure-acoustics@1.1.0`이다. 관련 기존 예제 8개의 literal 참조를
갱신하고 새 예제 2개를 추가했다. 제거한 Solver 버전의 사용자 Experiment를
자동 재지정하지 않는다. 최종 Catalog revision은
`10313d0b5c647e1432faa23ca4413e44202cf1d24b1d6d9f6d83acc44586f202`다.

| 공개 CLI 실행 | 성공 child 호출 | 최종 상태 시각 | runtime 측정 시간 | 결과 기록 / ACK |
|---|---|---|---|---|
| E1 직접 가진 관 | 4 | 0.02 s | 4.795 s | 2 / 2 |
| E2 실제 구조 연결 | 65 | 0.015625 s | 601.961 s | 4 / 4 |

E2는 구조 초기화 1회와 32개 구조·음향 호출 쌍을 모두 실행했다. 별도
pytest 전체 child harness도 611.57 s에 통과했다. 각 시간은 다른 검증과
동시에 실행한 wall time이며 단독 실행의 성능 보증값은 아니다.

E1 관측점은 2001개 표본이며 압력 범위는 −0.357483–0.357800 Pa,
해석 진행파와의 상대 L2 오차는 0.173873%다. E2의 구조 변위·속도는
`[1,6,6,1025,1,1,3]`, 압력 field는 `[20,3,3,52,1,1,1]`, 압력 probe는
`[1,1,1,1025,1,1,1]`이다. 모든 값은 유한하고 시간 중복이 없다.
E2 probe 압력은 −0.000179156–0.000179331 Pa, 기록된 최대 절대 변위는
4.38294e-11 m였다. probe와 checkpoint는 1024 step까지 도달하지만
stride 20의 field 기록은 1020 step, 즉 0.01556396484375 s에서 끝난다.
이 차이는 기록 규약에 따른 것이다.

로컬 실행 manifest와 검증 요약은
`.local/acoustic-catalog/release-result-e1/1/` 및
`.local/acoustic-catalog/release-result-e2/1/`에 남겼다. CPU 결과 대조는
`.local/acoustic-cpu-coverage.json`, 개별 시험 결과와 수렴 수치는 같은
`.local/` 아래 `acoustic-*.xml`에 있다. E1 source hash는
`4a77d75ae81293c93ec53f9376983af3f274ce03aad82783c114a67d9c8e346f`,
E2는 `d32c1f98d3784d6fcf2b42a7471262677f44863e200c09ecddb34e0f1d6d7a6a`다.

## 진행파의 독립 공간 수렴

0.5 × 0.1 × 0.1 m 관, 밀도 1.2 kg/m³, 음속 343 m/s, 강체 측벽과
matched 종단을 사용했다. 입력은 250 Hz, 길이 0.004 s의 Hann tone burst이고
관측 위치는 x = 0.125, 0.25, 0.375 m다. 0.016 s까지 계산했으며 세 격자에서
공통 시간 간격 0.00001 s를 사용했다. 이 짧은 검증용 pulse는 공식 E1의
기본 pulse와 구별된다.

기준 시간파형은 `p(x,t)=rho*c*V(t-x/c)`다. 복소 응답은 실제 입력 속도의
Fourier 성분으로 압력을 나누어 계산했다. 100–400 Hz의 등간격 13개 주파수를
평가했고 모든 입력 성분은 이 대역 최대값의 50%보다 컸다. 파형 오차는 세
관측점·전체 시간의 상대 L2 norm, 복소 오차는 관측점·대역 최대 절대 차이를
입사 압력 `rho*c`로 나눈 값이다. 응답 영점의 위상이나 점별 상대 오차를
평가하지 않았다.

| 목표 공간 간격 (m) | 격자 셀 수 | 파형 상대 L2 오차 | 복소 응답 최대 오차 |
|---|---|---|---|
| 0.05 | 10 × 2 × 2 | 1.70837% | 3.13461% |
| 0.025 | 20 × 4 × 4 | 0.50372% | 0.84422% |
| 0.0125 | 40 × 8 × 8 | 0.12321% | 0.20191% |

가장 세밀한 격자에서 복소 응답 오차 1% 목표를 만족한다. 이 결과는 선언한
benchmark의 결과이며 모든 형상·대역·기본 격자의 정확도를 보증하지 않는다.

## 시간 수렴과 FEM 교차 검증

시간 수렴은 공간격자 20 × 2 × 2를 고정하고 강체 관의 첫 압력 모드를
사용한다. 동일한 공간 이산화의 정확한 각주파수
`omega_h=2*c/dx*sin(pi*dx/(2*L))`에 대한 해와 비교한다.
0.015625 s에서 dt = 2⁻¹⁵, 2⁻¹⁶, 2⁻¹⁷ s를 비교하고 연속 오차 비가
3.8–4.2인지 검사한다. 초기 속도는 t=0의 정지 조건에 맞는 backward
half kick으로 설정한다. 따라서 공간 분산과 시간 분산의 상쇄를 시간 수렴으로
판정하지 않는다.

| dt (s) | 동일 공간 모델의 상대 L2 오차 |
|---|---|
| 0.000030517578125 | 0.479829% |
| 0.0000152587890625 | 0.120123% |
| 0.00000762939453125 | 0.030041% |

독립 harmonic FEM은 같은 세 단계의 mesh에서 100/250/400 Hz의 해석해와
비교했다. 입사파로 정규화한 최대 복소 오차는 각각 2.25922%, 0.51376%,
0.13070%였다. 가장 세밀한 두 모델의 FEM–FDTD 차이는 0.32986%로
2% 목표를 만족한다. 각 FEM 선형계의 상대 잔차는 1e-8 미만이다.

## 반사와 에너지

종단 저항이 `9*rho*c`인 분리된 첫 반사 시험은 해석 반사계수 0.8에 대해
0.799773555를 얻었다. 반사 파형의 입사파 정규화 L2 오차는 0.24072%이고
입사·반사 peak 도착 시각 오차는 4 dt 이하다. 이 시험의 축방향 간격은
0.001 m, dt는 0.000002 s, pulse는 2000 Hz/0.0005 s다.

무가진 3D 격자의 여섯 경계·edge·corner에서 강체벽과
`Z/(rho*c)=0.01,1,100`을 각각 500 step 검사했다. 매 step 에너지 수지
오차는 초기 에너지의 2e-14 이하, 누적 오차는 5e-13 이하이며 저항 경계의
에너지는 감소한다. 직접 가진과 matched 종단은 2048 step 동안 외부 일과
저항 소산을 따로 누적했다. 가진 종료 후 가짜 성장이 없고 최종 에너지는
peak의 1e-4 미만이다. 이 검사는 문서의 cross-time 수정 에너지에 대한
수지이며 구조와 유체 전체의 에너지 보존을 뜻하지 않는다.

## 실제 구조 연결과 시험 대응

구조 초기화는 구속조건을 적용한 t=0 프레임 한 점을 반환한다. 실제 창은
성공한 내부 적분 단계마다 선택 표면의 병진 속도를 수집하며 예측용
`fea.motion`과 분리된다. 공식 연결 예제는 작은 초기 운동의 자유응답이다.
구조 예측 단계가 작은 변형 범위에 머물도록 +x 초기 속도를 1e-6 m/s로 명시하고, 실행
비용을 고려해 구조 목표 간격을 0.02 m로 설정했다. 이 성긴 solid mesh는
연결 시연용이며 구조 주파수·진폭의 정밀 평가에는 별도의 mesh 수렴이 필요하다.

아래 표는 기본 예제 축소 이전의 검증 기록이다. 원래 형상과 첫 32-step 창은
`test_acoustic_geometry_variants.py`의 명시적 검증 조건으로 유지한다.
공개 CLI의 candidate build에 형상 변수만 달리 입력하고, 당시 공식 소스에서
구조 초기화·실제 창·음향 child를 실행했다. 두 경우 모두
표면 면적·외향 법선·primitive provenance, 실제 시간 구간, 압력의 일곱 축,
해제 뒤 mmap/resource 정리를 확인했다. 아래 시간은 전체 예제 실행과
동시에 측정한 초기화 및 첫 창의 wall time이다.

| 판 폭 × 높이 (m) | 구조 절점 | 전달 표면 절점 / tri3 | 음향 격자 | 초기화·첫 연결 창 |
|---|---|---|---|---|
| 0.08 × 0.07 | 130 | 41 / 64 | 25 × 4 × 4 | 38.29 s |
| 0.09 × 0.08 | 199 | 61 / 96 | 25 × 5 × 4 | 51.20 s |

두 mesh와 grid identity는 달라졌지만 같은 semantic 접합면을 자동 선택했다.
전달 표면은 각 내부 구조 step을 포함한 33개 시각 표본이고, 첫 acoustic
종료 시각은 `32/65536 = 0.00048828125 s`였다. 절점 번호·mesh 연결·전달
행렬을 task에 수기로 넣지 않았다.

| ID | 검증 내용 | 근거 시험 |
|---|---|---|
| T1 | 기존 구조 해석, harmonic 음향, 공식 예제 회귀 | CPU 전체 회귀 및 Catalog 예제 harness |
| T2 | 초기/실제/예측/trial, adaptive 표본, 출력 독립성 | `test_transient_surface_motion.py`, `test_acoustic_fdtd.py` |
| T3 | P1 면 적분, 법선 부호, 국소 상쇄, coverage | `test_transient_coupling_methods.py` |
| T4 | 비일치 시간표본의 정확한 적분, 범위, half-step | 위 전달 시험과 `test_acoustic_fdtd.py` |
| T5 | 독립 공간 수렴 및 고정 공간 모델의 시간 수렴 | `test_acoustic_fdtd_accuracy.py`, `test_acoustic_fdtd.py` |
| T6 | FEM 자체 수렴과 FDTD 비교 | `test_acoustic_fdtd_accuracy.py` |
| T7 | 반사, 강체 보존, 저항 소산, 종료 후 감쇠 | `test_acoustic_fdtd.py` |
| T8 | 창 분할과 같은 checkpoint 재계산의 배열 일치 | `test_acoustic_fdtd.py`, `test_acoustic_recording.py` |
| T9 | 잘못된 시간·격자 거부 후 원 checkpoint 재사용 | `test_acoustic_recording.py`, `test_acoustic_transient_lifecycle.py` |
| T10 | 공개 build, 실제 child typed 전달, record/ACK | `test_catalog_examples.py`, `test_acoustic_geometry_variants.py` |
| T11 | 전역 stride, 중복 없는 누적 출력, 출력 독립성 | `test_acoustic_recording.py` |
| T12 | 불변 checkpoint, 해제·취소·rollback·mmap 정리 | `test_acoustic_transient_lifecycle.py`, `test_acoustic_geometry_variants.py` |

기록 시험은 총 127 step, 창 27 step, stride 7을 포함한다. 마지막 상태는
127 dt이고 마지막 기록은 126 dt다. t=0은 한 번만 남으며 창 경계나
최종 시각을 stride 밖의 가짜 표본으로 추가하지 않는다. 요청 output은 매
호출 누적값을 반환하고 공식 예제는 마지막에 한 번 기록한다.

실제 child 수명 시험 2개는 57.98 s에 통과했다. 초기 프레임과 잘못된 창의
거부 후 state revision·Resource 수·mmap 파일이 그대로 남는지 확인하고,
같은 구조 중간 checkpoint에서 음향을 두 번 계산하여 상태와 압력 배열의
완전 일치를 확인했다. 이미 소비한 표면 창의 재사용은 거부하고 원래
checkpoint는 다시 사용할 수 있었다. 실제 child 시작 후 취소한 경우도
같은 checkpoint에서 재개했다. 모든 handle을 해제하고 run을 닫은 뒤
resource 수는 0이고 buffer 디렉토리는 제거됐다.

## 재현 명령

아래 명령은 저장소 루트에서 실행하며 출력 디렉토리는 비어 있어야 한다.
구체적인 예제 정의는 복사해 유지하지 않고 Catalog에서 빌드한다.

```powershell
.\caemble.cmd doctor
.\caemble.cmd experiment build --example transient-matched-impedance-duct --vars-mode nominal --out .local/e1-build
.\caemble.cmd experiment test .local/e1-build --out .local/e1-result
.\caemble.cmd experiment build --example transient-plate-driven-duct --vars-mode nominal --out .local/e2-build
.\caemble.cmd experiment test .local/e2-build --out .local/e2-result
```

부분 수정의 기본 검사는 `poetry run python -m tests.run affected`다.
전체 CPU 검증이 필요할 때는 `poetry run python -m tests.run full`을 명시적으로
실행한다. 기존 `pytest tests -m "not cuda"`도 같은 전체 검사 집합을 유지한다.
수렴 수치를 JUnit에 남길 때는 `-o junit_family=xunit1 --junitxml=<path>`를
추가한다. 현재 기본 예제의 형상과 실행 조건은 Catalog를 따른다.
CAE 디렉터리의 `python -m tests.run examples --key transient-plate-driven-duct`는
명목 실행을 입력 빌드부터 자원 정리까지 180 s 예산으로 측정한다. 이 개발용 예산은
사용자 해석의 timeout과 독립적이다. 이전 형상·창 분할·수렴 조건은 별도 검증에서 유지한다.

표면 전달은 기준 형상의 동일 평면 패치와 작은 변형만 지원한다. 영구
checkpoint 복구, acoustic 반력, 임의 곡면, PML, 열점성 손실, 오디오
재표본화는 이번 검증 범위에 없다.
