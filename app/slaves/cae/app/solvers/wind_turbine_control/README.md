# 발전기 토크와 날개 피치 제어

이 모듈은 입력 운동 파형의 발전기 속도를 보고 명령을 만든다. 로터의 관성이나
축 운동은 구조 Solver가 계산한다. 제어기가 로터 속도를 별도로 적분하지 않는다.
터빈별 계수는 Catalog/Experiment 입력으로 받으며, Python 안에 특정 터빈의
기본값을 숨기지 않는다. `entry.py`는 ABI, `domain.py`는 입력, `formulation.py`는
제어식, `outputs.py`는 artifact 포장을 담당한다.

먼저 속도에 저역통과 필터를 적용한다. 낮은 운전 속도에서는 발전기 토크를
0으로 두고, 최적 운전 영역에서는 `K ω²`, 정격 이후에는 `P/ω`로 목표 토크를
정한다. 중간 영역은 연속적인 선으로 연결한다. 토크 변화율과 최대 토크를 제한한다.

피치 제어는 정격 속도와의 오차를 비례 항과 적분 항으로 합한다. 현재 피치에
따라 두 항의 gain을 낮추고, 피치각·피치 속도·적분 상태에 한계를 둔다.
`ratedGeneratorSpeed`는 피치 PI 기준 속도이고, `region3GeneratorSpeed`는
토크 곡선의 정격 전환 속도다. 두 의미를 하나의 계수로 합치지 않는다.
`ratedMechanicalPower`는 발전기 입력의 기계적 출력이다. 전기 출력 비교에는
별도의 발전기 효율을 적용한다.

구간 첫 표본의 명령은 이미 채택된 명령이다. 이후 실제 표본 간격으로 제어기를
전진한다. 마지막 필터·적분·명령 상태만 자신의 task namespace에 반환한다.
같은 checkpoint로 연성을 재시도하면 제어기가 같은 시간을 두 번 적분하지 않는다.
첫 실행에서도 다른 task의 상태를 보존하면서 필요한 namespace를 생성한다.

직접 API는 `control_response`, 정적 토크 곡선은 `generator_torque`이다.
`tests/test_wind_physics.py`는 영역 연결, 변화율/포화 제한, 재시작 및 실제
StateStore 적용을 검사한다. 시간 간격은 정확도를 보장하는 상수가 아니다.
구조 적분 간격·출력 표본 간격·연성 창을 각각 줄여 관심 결과의 수렴을 확인한다.

제어식 출처는 [NREL 5 MW 정의 보고서](https://docs.nrel.gov/docs/fy09osti/38060.pdf)와
[고정 revision의 DISCON 소스](https://github.com/OpenFAST/r-test/blob/dd5feaaaa500ba7283140107806300d551cff0a7/glue-codes/openfast/5MW_Baseline/ServoData/DISCON/DISCON.F90)다.
원본 저작권과 Python 재구현의 변경 범위는 [NOTICE](NOTICE)에, 원본의
Apache-2.0 라이선스 전문은 [LICENSE](LICENSE)에 보존한다.

## 외부 OpenFAST 검증 작업

검증용 외부 실행은 Solver 런타임의 의존성이 아니다. 정상 CAE 실행은 Python과
NumPy/SciPy로 완료된다. 외부 실행 파일·원본 데이터·결과는 저장소의 `.work/openfast-reference`
작업 폴더에 보관하며 설치나 배포 경로에 넣지 않는다.

이번 검증은 [공식 OpenFAST v5.0.0 release](https://github.com/OpenFAST/openfast/releases/tag/v5.0.0)의
`OpenFAST_Double_Release.exe`, `DISCON.dll`과 그 release가 지정한
`OpenFAST/r-test` revision `dd5feaaaa500ba7283140107806300d551cff0a7`를 사용한다.
OC3 monopile 사례의 원본은 `source/`, 변경된 사례는 `model/`에 있다.
`download_manifest.json`에 원본 URL·파일 크기·SHA-256을,
`original_settings.json`에 모든 수정 필드와 변경된 입력의 SHA-256을 기록한다.

저장소의 [검증 도구와 실행 안내](../../../tests/fea_reference/README.md)가
다운로드·사례 생성·실행·분석을 재현한다. 저장소 루트 PowerShell에서:

```powershell
.\app\slaves\cae\.venv\Scripts\python.exe app/slaves/cae/tests/fea_reference/openfast.py download
.\app\slaves\cae\.venv\Scripts\python.exe app/slaves/cae/tests/fea_reference/openfast.py prepare --suite original
.\app\slaves\cae\.venv\Scripts\python.exe app/slaves/cae/tests/fea_reference/openfast.py run --suite original
```

세 풍속은 각각 `wind08`, `wind11p4`, `wind18`에 저장된다. 원본 r-test의
저장된 `.outb`를 정답처럼 복사하지 않고 새 `.out`와 stdout/stderr를 만든다.
원본 OC3의 기울기/원추각/요각을 정렬하고, 동적 실속·tower shadow·tower drag·
skew 보정·2차 파랑을 끈 상태를 비교한다. BEM/Øye, BeamDyn/ElastoDyn/SubDyn,
DISCON과 Airy/Morison은 실제로 계산한다. 바람·파랑·조류·초기 조건과 모든
숫자는 각 실행의 settings manifest를 기준으로 확인한다.

`wind08`, `wind11p4`, `wind18`은 원본 공력 작용점 offset을 유지한 300초 실행이다.
별도의 `aligned*`는 offset을 0으로 둔 진단용 300초 실행이다. 두 그룹 모두
정상 종료했으며 원본 결과는 보존했다. `aligned*`는 공식 기본 터빈과 동일한
모델이라고 부르지 않는다. 변경 근거와 입력 hash는 `aligned_settings.json`에 있다.

`compare.py summarize`는 실제 `.out`를 SI 단위의 `reference_si.npz`로 바꾸고,
구간 통계와 native 제어기 replay를 `reference_analysis.json`에 기록한다.
기존 Catalog의 제어 계수를 읽어 실제 OpenFAST 발전기 속도를 입력했을 때,
세 풍속의 마지막 60초에서 토크 최대 차이는 0.84 N·m 이내, 피치 최대 차이는
1.42×10⁻⁶ rad 이내였다. 이는 제어기 컴포넌트의 검증이며 전체 구조 응답의
동등성을 뜻하지 않는다.

`rigid*`와 `offsetrigid*`는 유연성을 끄고 속도·피치를 고정한 2초 BEM 진단이다.
전자는 작용점 offset 0, 후자는 원본 offset을 사용한다. 모든 57개 단면과
끝점의 Prandtl 극한을 사용하는 native 계산을 실제 OpenFAST 결과와 비교했다.
원본 offset 그룹에서 추력 평균 차이는 0.018% 이내, 회전축 토크 평균 차이는
0.074% 이내였다. 분포 하중의 모멘트를 적분하는 방식과 절점 하중의 모멘트를
합하는 방식은 이산화가 달라 작은 차이가 남는다. 정확도를 맞추기 위한
경험적 보정 계수는 사용하지 않는다.

```powershell
.\app\slaves\cae\.venv\Scripts\python.exe app/slaves/cae/tests/fea_reference/compare.py summarize --suite original --built .work/fea-turbine-third/items/1.json
.\app\slaves\cae\.venv\Scripts\python.exe app/slaves/cae/tests/fea_reference/compare.py replay-aero --suite offsetrigid --built .work/fea-turbine-third/items/1.json
.\app\slaves\cae\.venv\Scripts\python.exe app/slaves/cae/tests/fea_reference/compare.py compare --case wind11p4 --native .work/native-wind11p4.npz --start 240 --end 300
```

마지막 명령의 native NPZ에는 `times`와 비교할 SI scalar 파형을 넣는다.
인식하는 이름은 분석 스크립트의 `CHANNELS`에 있다. 선형 시간 보간 후
평균·RMS 차이·최대 차이를 보고하며, 임의의 합격 허용오차를 만들어 붙이지 않는다.

외부 해석과의 비교에서는 물리 모델, 단면 강성·질량, 구속, 부력, 수력 적분,
초기 평형과 제어 초기화까지 맞춰야 한다. 단지 같은 NREL 이름의 터빈을
사용했다는 이유로 차이를 수치 오차로 간주하지 않는다. 짧은 실행은 연결 검증이고,
긴 실행의 평균·진폭도 별도의 간격/메시 수렴 확인이 있어야 정확도 근거가 된다.
