# 입자 해석: DEM, SPH, MPM

입자 해석은 Geometry 내부에 입자를 생성하고, 각 입자의 위치·물리량·ID·Material을
함께 추적합니다. DEM은 구형 입자의 접촉과 회전, SPH는 유체 흐름, MPM은
변형하는 고체를 다룹니다. 같은 입자 표시와 결과 형식을 사용하지만 서로 다른
물리 모델과 적분 방법을 사용합니다.

## 실행할 예제 선택

[Catalog Examples](/doc?help=examples)에서 다음 이름으로 검색하고 전체 source를
확인하세요. 계수·단위·정확한 method ID는 예제와 연결된
[Solver 계약](/doc?help=solvers), [Material Model 계약](/doc?help=materials)이 기준입니다.

| 예제 | 확인할 내용 |
| --- | --- |
| dem-floor-contact | 중력으로 떨어지는 입자와 고정 바닥의 접촉 |
| dem-two-material-collision | 서로 다른 Material 입자의 충돌과 명시적 접촉 모델 선택 |
| dem-incline-rolling | 경사면 위에서 마찰에 의해 발생하는 이동과 회전 |
| sph-hydrostatic-column | 닫힌 유체 기둥의 초기 침강 과정; 짧은 실행의 최종값은 정수압 평형이 아님 |
| incompressible-sph-periodic-channel | 같은 주기 유로에서 CFD와 SPH의 점성 유체 속도 분포 비교 |
| mpm-affine-compression | 바닥이 고정된 고체의 초기 압축과 뒤이은 탄성 반등의 변형·응력 |

Workbench의 Experiment 탭에서 예제를 열고 Vars 준비 후 **실행**을 누릅니다.
연결된 CAE Launcher가 필요합니다. CLI에서 실행하려면
[Experiment 작성·실행 안내](../../authoring/experiment.md)의 `catalog show examples`,
`experiment init`, `experiment check`, `experiment test` 순서를 따르세요.
`check`는 입력을 검증하고, `test`가 검증된 입력으로 로컬 Solver를 실행합니다.
실행 범위와 source를 그대로 유지하며 표시 편의를 위해 시간 간격이나 입자 수를
자동으로 줄이지 않습니다.

## 설정은 어디에 두나요

- **Geometry**는 입자를 생성할 실제 체적과 고정 벽을 제공합니다. 생성 간격은
  입자 배치를, DEM 반경은 접촉에 사용할 구의 실제 크기를 결정합니다.
  잘린 체적이나 구멍을 bounding box 전체로 채우지 않습니다.
- **Material**은 밀도·점도·탄성 같은 물리 모델과 계수를 소유합니다.
  Material 이름을 바꾸어도 다른 물성이 자동 적용되지 않습니다.
- **MaterialInteraction**은 Material 쌍에 적용할 DEM 접촉·마찰 모델을 선택합니다.
  입자와 고정 벽은 같은 body target에 포함됩니다. 명시하지 않은 선택적 그룹에는
  Solver 계약의 기본 모델을 사용하고, 잘못되거나 모호한 명시적 선택은 오류입니다.
  같은 Material 쌍의 입자–입자와 입자–벽 접촉은 같은 선택을 사용합니다.
- **Task 설정**은 시간 적분, 초기 속도·중력과 해석 영역을 소유합니다.
  SPH의 평활 길이·수치 음속, MPM의 계산 격자도 여기에 속합니다.
- **Output Box와 gridShape**는 관측 위치와 기록 해상도를 결정합니다.
  MPM 계산 격자와 Output Box는 별개입니다. 관측 Box나 출력 표본 간격을 바꾸어도
  물리적 초기 조건이나 적분 시간 간격은 바뀌지 않습니다.

한 번의 실행 구간이 끝나면 입자 상태와 필요한 접촉·재료 이력을 보존합니다.
다음 `sim.run`은 그 Task의 상태에서 계속합니다. 입자 ID는 배열의 현재 행 번호가
아니며, 수치 Solver가 배열을 재정렬해도 ID·Material·물리량의 대응을 유지합니다.

## 입자와 수치 Output 보기

Viewer의 결과 선택에서 Task의 자동 **particles** 시각화를 엽니다.
시간 슬라이더, 이전·다음 프레임과 재생 버튼으로 저장된 시점을 확인합니다.
프레임 사이에 새로운 물리 상태를 계산하거나 입자 위치를 보간하지 않습니다.
카메라는 재생 중 유지합니다.

**물리량**에서 Material 또는 저장된 속성을 선택합니다. 벡터·Tensor는
**성분** 또는 **Norm**으로 표시하고, 물리량 종류와 단위를 함께 확인합니다.
Norm은 기록된 성분의 유클리드 크기이며 응력의 von Mises 값이 아닙니다.
색상 범위는 현재 프레임의 값에 맞춥니다. **ID**를 선택하면 그 입자의
Material, 위치와 모든 저장 물리량을 아래에서 읽을 수 있습니다.

DEM은 저장된 물리적 반경으로 구를 그립니다. SPH·MPM의 **점 크기**는 화면 표시만
바꾸며 입자 질량·체적·계산 간격을 바꾸지 않습니다. Geometry는 필요할 때 켜고,
저장 결과와 source·Vars가 일치할 때만 겹칩니다.

수치 분석에는 별도로 기록한 Box Grid를 선택합니다. 밀도는 cell 질량을 전체
cell 체적으로, 운동량 밀도는 cell 운동량을 전체 cell 체적으로 나눈 값입니다.
속도는 운동량을 질량으로 나누며 빈 cell은 0입니다. Histogram·Heatmap과
Calculation에서는 이 수치 Output을 사용합니다. 자동 입자 시각화와 native
particle export는 `sim.record`나 Calculation 입력이 아닙니다.
자세한 구분은 [RecordedData와 Viewer](program-domain-recording.md)를 참고하세요.

SPH 압력 Output은 cell 안 입자의 현재 체적 `질량 / 입자 밀도`를 가중치로
사용한 평균입니다. 입자 밀도는 그 입자의 재료 밀도이며, 위의 전체 cell 체적당
질량밀도와 다릅니다. 입자 중심이 포함된 cell에 값을 모으므로 유체 경계의
정확한 형상이나 cell 전체의 압력 적분을 나타내지는 않습니다.

빈 cell에는 압력 0을 저장합니다. 압력과 **같은 Box·gridShape·scope·시간 표본**의
질량밀도를 함께 기록하고 `질량밀도 > 0`인 cell을 유효영역으로 사용하세요.
그러면 물질이 있는 cell의 실제 압력 0과 빈 공간을 구분할 수 있습니다.
압력은 기준 밀도에 대한 gauge pressure이며 음수도 그대로 기록합니다.
두 SPH 공식 예제는 압력과 질량밀도를 함께 기록합니다.

저장된 Measurement와 CLI 로컬 결과는 실행 당시의 계약·단위·ID·Material 및 시간
표본으로 다시 엽니다. 다른 Solver가 native particle export를 받을 수 있는지는
그 Solver의 입력 계약에 따릅니다. 서로 다른 Solver의 continuation state를
그대로 이어 쓰지는 않습니다.
입자 속성 하나를 독립 particle Field로 전달하는 경우에도 그 Field의 domain에
좌표·ID·Material 대응이 유지되며 소비 Solver의 typed input 계약을 따라야 합니다.

## 현재 지원 범위

- DEM은 구형 입자와 움직이지 않는 벽의 접촉을 계산합니다. 반발계수를 입력해
  감쇠계수를 추정하지 않으며, 접촉 모델이 소유한 강성·감쇠 계수를 사용합니다.
- SPH는 단일 유체 Material, 일정한 입자 간격과 평활 길이를 사용합니다.
  영역은 축에 정렬된 Box이고, 주기가 아닌 방향의 양쪽 면에는 대응하는 고정 벽이
  필요합니다. 주기 면에 벽을 동시에 둘 수 없습니다. 열린 자유표면과 임의 형상의
  내부 장애물 해석은 현재 범위에 포함하지 않습니다. 주기 방향의 길이는 kernel
  support 반경보다 커야 합니다. 압력은 기준 밀도에 대한 gauge pressure이므로
  음수 값이 나올 수 있습니다.
- MPM은 단일 고체 Material과 정육면체 cell의 계산 격자를 사용합니다.
  고정 벽은 해당 격자의 고정 node로 반영합니다. 입자가 계산 격자에서 필요한
  보간 영역을 벗어나면 오류가 발생하므로 변형할 여유를 두세요.
  압축 예제는 초기 속도 구배로 운동을 시작하며, 지정한 속도로 계속 움직이는
  압반 경계조건은 지원하지 않습니다.
  Neo-Hookean 유한변형 상태에서 양의 체적비와 유효한 재료 응답이 필요합니다.
  timestep 축소로도 유효한 후보를 얻지 못하면 오류가 발생합니다. 기준/현재
  배치의 응력 Output은 각각 해당 재료 체적으로 가중한 world Cauchy 응력입니다.
- 세 Solver 모두 생성 이후 입자 수가 고정됩니다. 지원하지 않는 설정은
  다른 물리 모델로 바꾸어 계산하지 않고 오류로 알려 줍니다.
