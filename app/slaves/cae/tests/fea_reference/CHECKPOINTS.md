# 같은 확정 상태에서 시간 간격 비교하기

`checkpoint.py`는 장시간 운전 검증의 예열 비용을 줄이는 **tests 전용 도구**다.
Runtime이나 Solver의 공개 재시작 기능을 추가하지 않는다. 첫 실행은 실제
Catalog 프로그램으로 예열하고, 요청한 연성 구간이 수렴한 직후 전체 Task
상태를 복사한다. 구조 변위·자세·속도·가속도·여러 바퀴의 조인트 상대각과
재료 이력뿐 아니라 제어기 필터/적분기, 공력 유입 이력, 수력 시각도 보존한다.
함께 저장한 interface, 예측 파형, 마지막 trial의 운동·공력·수력·제어 명령은
그 상태의 출처를 확인하는 자료다. 실행 범위에 묶인 handle이나 mmap 경로는
저장하지 않는다.

분기는 새 실행의 상태 저장소에 복사본을 넣는다. 첫 구조 호출은 저장된
물리 상태에서 interface와 다음 구간의 예측 파형만 구성하는 진단 단계다.
`branch-provenance.json`과 실행 trace에 `physicalSteps: 0`으로 기록한다.
그 뒤에는 원래 Catalog 프로그램의 네 Solver 호출·연성 반복·자원 해제·
Record ACK를 그대로 사용한다. 첫 호출에서 기존 구조 entry를 실행하면
연성 하중 없이 한 구간이 진행되므로 그렇게 하지 않는다.

허용하는 변경은 구조 `fea.time`의 `dt`, `windowSize`, `duration` 값과
대응하는 반복 횟수용 Vars뿐이다. 그 외 전체 Measurement, Catalog 계약,
네 Solver 소스 hash, Python/NumPy/SciPy 버전은 같아야 한다. 이 검사가
끝난 뒤에만 네 Task의 `modelIdentity`를 새 시간 설정의 식별자로 바꾼다.
원래 식별자로 되돌린 상태의 hash가 저장 상태와 같은지도 확인한다.
이 제한은 재료·하중·허용오차·감쇠·기록 절점 변경을 함께 허용하지 않는다.
시각 덧셈의 작은 꼬리는 Solver와 같은 scale-aware 경계 판정으로 다루며,
허용 폭은 `min(dt, windowSize)`의 백만분의 일 이하다. 상태의 실제 시각은
수정하지 않고 반복 횟수용 duration만 정수 구간 수에 맞게 표현한다.

다음 명령은 저장소 루트에서 실행한다. `$feaCase`에는 비교하려는 운전
조건으로 **이미 빌드한 동일 artifact 폴더**를 넣는다. 모든 시각은 절대
물리 시각이며 `--duration 248`은 240초 상태에서 8초를 더 계산한다는 뜻이다.

```powershell
$feaPython = (Resolve-Path 'app/slaves/cae/.venv/Scripts/python.exe').Path
$feaCase = '.work/fea-turbine-final-v6'
& $feaPython app/slaves/cae/tests/fea_reference/checkpoint.py --artifact $feaCase --out .work/fea-warmup --duration 300 --in-process --timeout 172800 --checkpoint-times 8 40 120 240 300
$feaSaved = '.work/fea-warmup/checkpoints/checkpoint-000240.000000.pkl'
& $feaPython app/slaves/cae/tests/fea_reference/checkpoint.py --artifact $feaCase --out .work/fea-branch-dt --duration 248 --dt 0.0025 --in-process --timeout 172800 --resume $feaSaved --checkpoint-times 248
& $feaPython app/slaves/cae/tests/fea_reference/checkpoint.py --artifact $feaCase --out .work/fea-branch-window --duration 248 --window 0.025 --in-process --timeout 172800 --resume $feaSaved --checkpoint-times 248
```

기존 benchmark를 그대로 호출하므로 촘촘한 실제 파형 관찰, 비교 채널,
입력/소스 보관과 결과 파일 형식도 유지된다. `--in-process` 결과는 수치
검증이며 프로세스 전송·취소 검증과 구분한다. 파일은 이 도구가 만든 로컬
pickle이며 SHA-256을 확인한 뒤 읽는다. 기존 파일은 덮어쓰지 않는다.

이 비교는 **같은 확정 초기 상태에서 시작한 운전 구간의 간격 민감도**다.
예열 240초 전체가 시간 간격에 수렴했음을 증명하지는 않는다. 먼저 같은
간격의 분기가 연속 실행과 일치하는지 확인하고, 평균만 아니라 한 파랑
주기 이상 전체 파형을 비교해야 한다. 현재의 일반 기록에는 선택 절점과
진단 채널만 있으므로, 관찰자를 붙이지 않은 과거 실행에서 이 전체 상태를
역으로 복원할 수 없다.
