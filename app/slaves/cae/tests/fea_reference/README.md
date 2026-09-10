# OpenFAST 기준해 재현

이 도구는 FEA/풍력 Solver의 외부 검증용이다. 실제 Solver 실행 중에는
OpenFAST를 실행하거나 인터넷에서 파일을 받지 않는다. Python 계수의 정식 출처는
Catalog와 그것을 컴파일한 built artifact이며, 여기에는 모델 계수를 복제하지 않는다.
실제로 완료한 검사와 남은 판정은 [검증 기록](VERIFICATION.md)에 정리한다.

`openfast.py`는 공식 OpenFAST v5.0.0 Windows double precision 실행 파일과
DISCON DLL을 받는다. 두 파일의 SHA-256은 코드에서 고정해 다운로드 직후와 실행
직전에 검사한다. r-test 데이터는 release의 submodule revision
`dd5feaaaa500ba7283140107806300d551cff0a7`로 고정한다. 바이너리와 원본 데이터는
`.work/openfast-reference`에 저장하며 Git에 넣지 않는다.

`original` suite의 세 사례는 일정 바람 8/11.4/18 m/s, Airy 파랑 진폭 1 m·주기
8초·위상 0, 일정 조류 +X 0.2 m/s를 사용한다. 수심은 20.0001 m, 물 밀도는
1025 kg/m³, 중력은 9.81 m/s²다. 회전축 기울기·원추각·요각은 0이며, 원본
공력 작용점 offset은 유지한다. 초기 회전속도는 9/12.1/12.1 rpm, 초기 피치는
0/0/12도다. 바람의 shear, tower shadow/drag, skew 보정, 동적 실속, 2차 파랑을
끈다. 이는 비교용 설정이며 공식 OC3 기본 설정과 동일하다고 주장하지 않는다.

Blade는 `CompElast=2`의 BeamDyn이며 고정된 원본 6×6 단면 강성/질량/감쇠를
사용한다. 타워·드라이브트레인은 ElastoDyn, 고정식 monopile은 SubDyn,
공력은 BEM/Prandtl/Buhl/Øye, 제어는 공식 DISCON, 수력은 Airy/Morison이다.
시간 간격과 출력 간격은 0.005초다. 기본 300초 실행 후 마지막 60초 통계를
비교하지만, 이 선택 자체가 수렴이나 정상상태를 보장하지는 않는다.

`prepare`의 기본 `--initial-state source`는 공식 초기 조건을 유지한다.
여기에는 BeamDyn의 `QuasiStaticInit=True` 사전 변형 계산과 ElastoDyn의
`PtfmHeave=-0.0009 m`가 포함된다. 처음에 탄성 변형을 0으로 두는 native
해석과 초기 과도 응답을 비교하려면 별도 폴더에서 `--initial-state unstrained`를
사용한다. 이 옵션은 `QuasiStaticInit=False`, `PtfmHeave=0`으로 설정하고,
수정한 공통 입력을 별도 `5MW_UnstrainedBaseline` 폴더에 둔다. 기본 source
조건의 기존 300초 결과를 덮어쓰거나 같은 초기 조건으로 표시하지 않는다.

```powershell
$feaPython = (Resolve-Path 'app/slaves/cae/.venv/Scripts/python.exe').Path
& $feaPython app/slaves/cae/tests/fea_reference/openfast.py download --directory .work/openfast-matched
& $feaPython app/slaves/cae/tests/fea_reference/openfast.py prepare --directory .work/openfast-matched --suite original --initial-state unstrained
& $feaPython app/slaves/cae/tests/fea_reference/openfast.py run --directory .work/openfast-matched --suite original --workers 3
```

`--initial-state`는 준비 단계의 옵션이다. 실행 단계는 저장된 settings에서 실제
공통 입력 폴더를 읽고, 그 폴더의 DISCON checksum도 검사한다. 이미 검증한
`source`, `bin`, `download_manifest.json`, `tree.json`을 새 폴더에 복사해도 된다.
모든 초기 조건 변경과 입력 hash는 새 폴더의 `original_settings.json`에 남는다.
새로 준비하는 기준해는 `TwrTpTDxi`를 추가로 출력한다. 이것이 실제 타워
꼭대기의 global X 변위다. 기존 `TwHt1TPxi`는 이 예제에서 높이 85.66 m의
중간 계측 지점 위치이며, 높이 87.6 m의 꼭대기 출력과 직접 비교하지 않는다.

저장소 루트 PowerShell에서 다음 순서로 실행한다. `$feaBuilt`는 publish된 Catalog를
CLI로 컴파일한 `items/1.json` 경로로 지정한다. 이미 만든 built artifact를
그대로 사용하고 단지 비교를 위해 Catalog를 수정하지 않는다.

```powershell
$feaPython = (Resolve-Path 'app/slaves/cae/.venv/Scripts/python.exe').Path
$feaBuilt = '.work/operating-built/items/1.json'
& $feaPython app/slaves/cae/tests/fea_reference/openfast.py download
& $feaPython app/slaves/cae/tests/fea_reference/openfast.py prepare --suite original
& $feaPython app/slaves/cae/tests/fea_reference/openfast.py run --suite original --workers 3
& $feaPython app/slaves/cae/tests/fea_reference/compare.py summarize --suite original --built $feaBuilt
```

처음 연결만 확인할 때는 별도 `--directory`에 `prepare --duration 2`로 짧게
실행한다. 그 결과를 요약할 때는 `--start 0 --end 2`를 쓴다. `--directory`는
모든 명령에 같은 경로를 전달한다. 긴 실행의 입력을 다시 준비하면 해당 입력을
덮어쓰므로, 별도 검증 조건은 별도 작업 폴더에서 비교한다.

`ramp`는 제어기의 변화 대응을 확인하는 별도 40초 기준해다. 30초까지
11.4 m/s, 30–35초에 12.4 m/s까지 선형 증가, 이후 일정한 바람을 사용한다.
공식 InflowWind의 `WindType=2` uniform wind 파일 형식으로 입력하며 방향·
수직풍·전단·gust 열은 모두 0이다. 이 사례의 공통 입력도 별도 폴더에 보관한다.

```powershell
& $feaPython app/slaves/cae/tests/fea_reference/openfast.py prepare --directory .work/openfast-matched --suite ramp --initial-state unstrained
& $feaPython app/slaves/cae/tests/fea_reference/openfast.py run --directory .work/openfast-matched --suite ramp --workers 1
```

native에서는 전체 named Vars를 사용해 `windSpeed=11.4`, `windDelta=1`,
`duration=40`, 초기 12.1 rpm·피치 0·토크 43093.55 N·m인 artifact를 만든다.
이 artifact를 benchmark에 넣을 때 `--wind`를 생략한다. `--wind`는 네 풍속
표본 모두를 같은 값으로 바꾸므로 ramp를 제거하기 때문이다. 실제 기준해의
`Wind1VelX`는 30/32.5/35초에서 각각 11.4/11.9/12.4 m/s로 확인됐다.
uniform wind 형식과 보간은 [공식 InflowWind 안내서](https://openfast.readthedocs.io/en/main/_downloads/a231262e7763b4d61759ebe4e0fc30b2/InflowWind_Manual.pdf)를 따른다.

공력 컴포넌트를 분리하려면 원래 결합 실행의 평균 속도/피치를 읽어 고정한
`offsetrigid` suite를 준비한다. 유연성을 끄고 원본 작용점 offset을 유지한다.
다음 native replay는 같은 운동의 강체 날개에만 적용한다.

```powershell
& $feaPython app/slaves/cae/tests/fea_reference/openfast.py prepare --suite offsetrigid
& $feaPython app/slaves/cae/tests/fea_reference/openfast.py run --suite offsetrigid
& $feaPython app/slaves/cae/tests/fea_reference/compare.py summarize --suite offsetrigid
& $feaPython app/slaves/cae/tests/fea_reference/compare.py replay-aero --suite offsetrigid --built $feaBuilt
```

작용점 offset의 영향을 분리하는 `aligned`는 offset 0의 유연한 전체 모델,
`rigid`는 offset 0의 강체 모델이다. `rigid`를 native replay할 때는
`--zero-offsets`를 함께 지정한다. 각 모델의 가정을 원본 결과와 섞지 않는다.

전체 native 결과와 비교할 때 NPZ에 `times`와 SI 단위 scalar 파형을 넣는다.
사용 가능한 이름은 `compare.py`의 `CHANNELS`에 있다. 출력은 평균·상대 평균
차이·RMS 차이·최대 차이다. 평균이 0인 채널의 상대 평균 차이는 정의하지 않는다.

```powershell
& $feaPython app/slaves/cae/tests/fea_reference/compare.py compare --case wind11p4 --native .work/native-wind11p4.npz --start 240 --end 300
```

`download_manifest.json`에는 원본 URL과 hash, `*_settings.json`에는 모든 변경
필드와 입력 hash가 있다. 각 사례에는 실제 `.out`, stdout/stderr, 종료 코드가
들어 있는 `execution.json`, SI 변환 NPZ와 분석 JSON이 생긴다. 프로그램이
정상 종료했는지까지 검사하며 저장된 r-test `.outb`는 내려받지 않는다.
실행 직전에는 준비할 때 저장한 모든 입력 hash도 다시 비교하며, 하나라도
변경되거나 없어졌으면 OpenFAST를 시작하지 않는다. 새 `execution.json`에는
검사한 입력 수와 정확한 settings 파일의 SHA-256을 함께 남긴다. 이 검사가
추가되기 전에 완료한 결과의 실행 증거는 그대로 보존한다. 그 입력을 나중에
다시 검사한 기록은 별도 `*_live_input_audit.json`이며, 실행 당시의 검사로
소급해 표시하지 않는다.

재현된 원본 offset 강체 사례에서 native 추력 평균 차이는 0.018% 이내,
회전축 토크 평균 차이는 0.074% 이내였다. 실제 generatorSpeed를 제어기에 다시
넣은 300초 replay의 마지막 60초에서는 토크 최대 차이가 0.84 N·m 이내,
피치 최대 차이가 1.42×10⁻⁶ rad 이내였다. 이 수치는 구성요소 확인 결과다.
전체 FEA의 메시/시간 수렴과 구조적 감쇠·초기 평형 차이는 따로 검증해야 한다.
또한 OpenFAST HydroFxi에는 물체 가속도에 대한 부가질량 반력이 포함된다.
native 외력 artifact와 비교할 때는 구조 질량항으로 옮긴 항을 함께 고려한다.

물체 운동을 고정한 `fixedhydro`는 수력만 따로 확인한다. 바람·제어·SubDyn을
끄고 ElastoDyn의 모든 운동 자유도를 고정한 채 같은 파랑·조류로 16초를 실행한다.
회전속도와 피치도 0이며, 세 운전점을 복제하지 않고 사례 하나만 만든다.

```powershell
& $feaPython app/slaves/cae/tests/fea_reference/openfast.py prepare --suite fixedhydro
& $feaPython app/slaves/cae/tests/fea_reference/openfast.py run --suite fixedhydro
& $feaPython app/slaves/cae/tests/fea_reference/compare.py replay-hydro --case fixedhydro --built $feaBuilt --start 0 --end 16 --interval .005
```

실제 16초 기준해와 비교한 수평 합력의 시간 가중 평균 차이는 +0.0157% 이내,
반 최대-최소 진폭 차이는 +0.0162% 이내였다. 파면 높이의 RMS 차이는
9.04×10⁻⁸ m 이내였다. 물체 가속도가 0인 이 비교에서는 부가질량 반력도 0이다.
움직이는 구조에서는 외력과 질량항의 분리를 맞춘 뒤 비교해야 한다.

`stationary`는 무중력·무유체·정지·피치 0 상태에서 HSS를 나셀에 대해 잠그고,
실제 OpenFAST를 0.01초 실행하여 t=0의 선형화 행렬을 얻는다. `modal.py`는
동일 built의 무응력 K/M을 사용한다. 이 검사는 운전 중 원심력이나 유체력을
받는 상태의 고유진동수를 나타내지 않는다.

```powershell
& $feaPython app/slaves/cae/tests/fea_reference/openfast.py prepare --suite stationary
& $feaPython app/slaves/cae/tests/fea_reference/openfast.py run --suite stationary
& $feaPython app/slaves/cae/tests/fea_reference/modal.py --built $feaBuilt
```

JSON에는 built/선형화 hash와 가정, NPZ에는 전체 모드 벡터와 절점 ID를 저장한다.
OpenFAST 값은 감쇠가 있는 상태행렬 고유값의 크기, native 값은 무감쇠 K/M의
고유진동수다. 모드의 정렬 순서만으로 서로 같은 모드라고 판단하면 안 된다.
확인한 첫 지지구조·구동계 모드는 다음과 같다.

| 모드 | native Hz | OpenFAST Hz | 차이 |
| --- | ---: | ---: | ---: |
| 첫 side-to-side 지지구조 | 0.27734635 | 0.27856052 | −0.436% |
| 첫 fore-aft 지지구조 | 0.27894262 | 0.28020607 | −0.451% |
| 구동계 | 0.61007466 | 0.61451198 | −0.722% |

native 전체 보 타워는 비틀림도 허용한다. 기준 ElastoDyn 타워는 굽힘 모드만
사용하므로 yaw와 결합한 블레이드 모드는 native 0.63256 Hz, 기준 0.68914 Hz로
약 −8.21% 차이가 있다. 차이의 원인을 분리하는 아래 **진단용** 명령은 지정한
타워 절점들의 world-Z 회전을 같게 두며, Catalog나 기본 모델을 수정하지 않는다.
이 예제의 타워 절점 ID는 6부터 16까지다.

```powershell
& $feaPython app/slaves/cae/tests/fea_reference/modal.py --built $feaBuilt --tie-tower-yaw (6..16)
```

이 진단에서 첫 flap 계열은 native 0.66797/0.67585/0.70447 Hz,
기준 0.68190/0.68914/0.71808 Hz로 약 2% 차이가 남는다. 전체 FEA 메시와
BeamDyn의 고차 요소, ElastoDyn 타워 모드, SubDyn의 Guyan 축약은 서로 다르다.
이 수치를 모든 모드·시간 응답의 정확도 보증으로 확대하지 않는다.

질량 감사에서는 고정된 BeamDyn 입력을 실제 실행한 blade 질량을 기준으로
삼았다. native의 midpoint 단면 적분은 blade당 −0.1058%, 타워는 −0.0371%
차이가 있고 pile은 출력 반올림 이내로 일치했다. `CompElast=2`에서는
ElastoDyn blade의 `AdjBlMs`가 BeamDyn에 적용되지 않으며, ElastoDyn 요약의
로터 질량에는 별도 BeamDyn blade 질량이 포함되지 않는다. 나셀의 CG 편심과
yaw 축 관성의 평행축 변환, 기준 모델이 유지하는 hub 축 관성과 transition yaw
관성은 Catalog 출처 설명에 기록한다. 나셀 roll/pitch 관성을 0으로 둔 것은
이 기준 모델의 생략을 맞춘 것이며, 실제 장치의 완전한 관성 텐서를 뜻하지 않는다.

초기 수력 차이를 조사할 때는 `hydro_diagnostics.py`로 실제 SubDyn 절점 가속도를
추가 출력한다. 아래 명령은 이미 준비한 `wind08`을 새 폴더에 복사한다. 공력·제어·
파랑 계수는 그대로이며, 출력 채널과 명시한 진단 옵션만 바뀐다. 기존 결과는 남는다.
`.work/nrel-below-built`는 Catalog 예제의 `reference.ts`에 있는 전체 Vars 절차로
만든 정격 이하 artifact다. 이 진단은 그 입력의 처음 0.1초만 실행한다.

```powershell
$feaMatched = '.work/openfast-matched'
& $feaPython app/slaves/cae/tests/fea_reference/hydro_diagnostics.py reference --directory $feaMatched --name hydrodiag --duration .1
& $feaPython app/slaves/cae/tests/fea_reference/hydro_diagnostics.py reference --directory $feaMatched --name hydrodiag-full --duration .1 --internal-modes 48
& $feaPython app/slaves/cae/tests/fea_reference/hydro_diagnostics.py replay --reference-case "$feaMatched/model/hydrodiag" --built $feaBuilt --out .work/hydro-replay
& $feaPython app/slaves/cae/tests/fea_reference/hydro_diagnostics.py native --artifact .work/nrel-below-built --out .work/native-all-node-motion --duration .1
```

`native`는 같은 ABI/상태 commit을 사용하는 프로세스 내 수치 계측이다.
수렴한 구간의 모든 절점 변위·속도·가속도와 수력 외력/부가질량을 NPZ에 저장한다.
`replay`는 기준해의 실제 절점 가속도로 `F_external − M_added a_body`를 계산한다.
기준해 속도는 변위를 시간 미분해 얻으므로 작은 차이는 남는다.
이 replay는 원래 파랑 조건용이며, 무중력·무파랑 진단 결과를 그대로 넣으면 안 된다.

중력 초기 과도응답을 분리하는 비교에서는 양쪽 모두 파랑을 끈다. `g=0`이면
파랑 분산식이 정의되지 않으므로 파랑만 유지한 무중력 시험은 유효하지 않다.

```powershell
& $feaPython app/slaves/cae/tests/fea_reference/hydro_diagnostics.py reference --directory $feaMatched --name gravity-on --no-wave --gravity 9.81
& $feaPython app/slaves/cae/tests/fea_reference/hydro_diagnostics.py reference --directory $feaMatched --name gravity-off --no-wave --gravity 0
& $feaPython app/slaves/cae/tests/fea_reference/hydro_diagnostics.py native --artifact .work/nrel-below-built --out .work/native-axial-diagnostic --duration .1 --tie-tower-axial (6..16)
```

마지막 명령은 타워 절점의 Z 변위를 platform 운동에 연결하는 **진단용 모델**이다.
굽힘과 비틀림은 유지하고 축방향 자유도만 비교하며, 기본 FEA 타워를 수정하지 않는다.
실제 8 m/s·무변형 초기 상태의 0–0.1초 조사에서는 다음이 확인됐다.

- 기준 절점 운동을 native 수력식에 넣은 RMS 차이는 627.4 N, 최대 차이는 1,349.5 N이었다.
- t=0.1초 native 수력은 +10,801 N, 기준은 −384,666 N이었다. 외력은 각각
  −3,445/−3,802 N 정도로 가깝고, 차이 대부분은 물체 가속도의 부가질량 반력이다.
- SubDyn 내부 모드를 모두 유지해도 기준값은 −291,630 N으로 차이가 남았다.
  native 축방향 연결 진단은 −37,316 N이었다. 어느 한 자유도 차이만으로
  전체 불일치를 설명하거나 합격으로 처리할 수 없다.
- 무파랑 기준에서 중력을 끄면 t=0.1초 수력이 −388,890 N에서 +4,791 N으로
  바뀌었다. 큰 초기 진동은 중력이 유발하는 구조 과도응답과 관련된다.

중력 합력 자체의 차이는 −0.0163%, platform에 대한 pitch 모멘트는 −0.325%로
질량 적분 차이 범위였다. `modal.py` JSON은 이제 중력 합력/모멘트와 수직 유효
모드 질량도 기록한다. 기본 native에서는 7.142 Hz 모드가 전체 질량의 약 53.6%,
26.935 Hz 모드가 약 18.4%의 수직 유효 질량을 차지했다. 이는 고차 구조와
초기 과도응답의 차이를 조사하는 근거이며, 서로 다른 모드의 일대일 대응은 아니다.
정상 운전 결과는 초기 진동이 가라앉은 구간에서 별도로 비교해야 한다.

전체 운전 수치 검증은 `fea_operating_benchmark.py`로 같은 built artifact를 실행한다.
`--in-process`는 수치 계산 시간을 측정하기 위해 child 생성만 생략한다. 같은
Task/ABI·checkpoint·연성 반복·Record ACK를 사용하지만, 실제 프로세스 간 전달과
취소 검사는 별도의 CLI/pytest 결과로 확인해야 한다. 출력 폴더는 새 경로여야 한다.
동시에 여러 사례를 계산할 때는 아래처럼 각 프로세스의 BLAS 스레드를 하나로
고정했다. 계산식이나 수렴 허용오차는 바뀌지 않는다. 체크포인트에서 분기할 때도
같은 환경을 사용하며, 한 번의 짧은 측정에서 큰 속도 향상이 입증된 것은 아니다.

```powershell
$env:OPENBLAS_NUM_THREADS = '1'
$env:OMP_NUM_THREADS = '1'
& $feaPython app/slaves/cae/tests/fea_operating_benchmark.py --artifact .work/operating-built --out .work/native-rated-300 --duration 300 --wind 11.4 --timeout 86400 --in-process
& $feaPython app/slaves/cae/tests/fea_reference/qualify.py --native-run .work/native-rated-300 --reference-case .work/openfast-matched/model/wind11p4 --start 240 --end 300 --out .work/native-rated-300/qualification.json
```

현재 계측기는 확정된 구간의 실제 운동 파형을 관찰하고 계산값은 바꾸지 않는다.
`comparison_si.npz`에는 내부 파형의 시간 좌표와 물리량별 SI 값이 들어 있다.
거부한 trial과 다음 구간의 예측 파형은 포함하지 않으며, 구간 경계도 중복하지 않는다.
초기의 2초·8초 진단 일부는 0.05초 구간 끝점만 계측했다. 이 자료는 10 Hz 이상의
진동을 충분히 표현하지 못하므로 최종 진폭 판정에 사용하지 않는다. 같은 실행의
Record 이력은 원래부터 0.005초 표본을 갖지만, 기록하지 않은 전 절점 가속도를
사후에 임의 보간해 수력 진폭을 복원하지 않는다.

검증 폴더에는 사용한 Measurement, Catalog build manifest, Solver Python 소스
snapshot과 SHA-256, 계측기 소스, Python/NumPy/SciPy 버전, 시간·기록 크기가 남는다.
실행 도중 작업 트리의 소스가 바뀌었는지도 보고한다. 프로세스 내 실행은 처음
import한 코드를 사용하므로 이후 편집본을 사용한 결과라고 표현하면 안 된다.

`qualify.py`는 두 실행의 정상 종료, 요청한 전체 구간, 0.005초 이하 표본 간격,
일곱 주요 채널과 실행 중 Solver 소스가 바뀌지 않았다는 증거를 확인한 뒤
평균 5%·반 최대-최소 진폭 10% 기준을 적용한다.
미달하면 JSON에 실제 차이를 남기고 종료 코드 1을 반환한다. 영인 기준값에
임의 분모를 더하지 않으며, 전후반 평균도 제공한다. 60초라는 비교 길이만으로
정상상태라고 자동 판정하지 않으므로 전체 그림과 평균 추세도 함께 확인한다.

내부 시간 간격과 연성 구간의 수렴 검사는 다른 입력을 유지한 두 실행을 비교한다.
`convergence.py`는 평균뿐 아니라 공통 시간 좌표의 전체 파형 차이를 기준 파형의
최대 절댓값으로 정규화하며 2% 초과 시 실패한다. 초기 2초만 검사한 결과를
바람 변화나 정상 운전 구간의 수렴 검사로 확대해서 보고하지 않는다.

```powershell
& $feaPython app/slaves/cae/tests/fea_reference/convergence.py --baseline .work/native-base/comparison_si.npz --refined .work/native-halfdt/comparison_si.npz --start 0 --end 8 --out .work/dt-convergence.json
uv run --no-project --with matplotlib --with numpy python app/slaves/cae/tests/fea_reference/plot.py --native .work/native-rated-300/comparison_si.npz --reference .work/openfast-matched/model/wind11p4/reference_si.npz --start 240 --end 300 --out .work/native-rated-300/comparison.png
```

Matplotlib은 그림 생성 도구의 선택 의존성이며 CAE 실행 의존성에 추가하지 않는다.
같은 명령의 출력 확장자를 `.pdf`로 바꾸면 별도 문서에 넣을 벡터 그림도 만들 수 있다.

출처: [공식 release](https://github.com/OpenFAST/openfast/releases/tag/v5.0.0),
[고정 r-test 입력](https://github.com/OpenFAST/r-test/tree/dd5feaaaa500ba7283140107806300d551cff0a7/glue-codes/openfast),
[BeamDyn 이론](https://openfast.readthedocs.io/en/main/source/user/beamdyn/theory.html).
[SubDyn 출력 정의](https://openfast.readthedocs.io/en/main/source/user/subdyn/appendixD.html)와
[축약 모델 이론](https://openfast.readthedocs.io/en/main/source/user/subdyn/theory.html)도 참고한다.
