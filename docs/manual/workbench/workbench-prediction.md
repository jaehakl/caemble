# Prediction으로 결과와 조건 예측하기

**Prediction**은 저장된 실행 결과를 바탕으로 새로운 조건의 결과를 예상하거나, 원하는 결과에 가까운 조건을 찾는 기능입니다. 예측은 기존 데이터에서 가까운 이웃을 찾는 kNN 모델을 사용합니다. 실제 Solver 계산과 얼마나 가까운지는 **Save & Run**으로 확인할 수 있습니다.

## 예측을 처음 사용한다면

1. 결과가 기록된 Experiment를 열고 **Prediction** 탭을 선택합니다. 새 Workbench의 기본 화면은 Experiment이며, 재방문할 때는 마지막 작업 화면을 복원합니다.
2. **Prediction Settings**에서 사용할 저장된 Calculation을 고르고 **적용**합니다.
3. 왼쪽 **Vars**를 조금 바꾸고 오른쪽 **Calculation Data**가 어떻게 달라지는지 살펴봅니다. 이것이 **Forward**, 즉 조건에서 결과를 예측하는 방향입니다.
4. 원하는 결과값이 있다면 오른쪽 값을 편집합니다. 입력한 값을 **Target**으로 삼아 조건을 찾는 **Inverse** 방향으로 바뀝니다.
5. 편집 가능한 내 Experiment라면 **Save & Run**으로 실제 계산을 실행하고 예측과 비교합니다.

학습에는 현재 Experiment의 Recorded Measurement가 사용됩니다. Inverse에 필요한 후처리 결과가 없다면 [Calculation에서 결과 저장하기](workbench-calculation.md#후처리-결과-저장)를 먼저 확인하세요. 왼쪽 Vars와 오른쪽 Calculation Data 사이에는 3D Viewer가 있고, 하단 Console에서 진행 상태와 오류를 볼 수 있습니다.

새로고침하면 마지막 탭과 Experiment·Measurement·Calculation 선택을 다시 검증하고, 현재 Experiment에 속하며 접근 가능한 선택만 복원합니다. 공유 URL에는 `?experiment=ID`만 저장합니다. 탭과 Measurement·Calculation은 URL에 담지 않으며, 과거의 `section`, `measurement`, `calculation`, `structure`, `sample`, `setup` 파라미터는 적용하지 않고 제거합니다.

## 공개 Demo로 체험하기

공개 Demo에서는 로그인 없이 Forward와 Inverse, Calculation 데이터, Analysis의 그래프·표·CSV, Experiment 소스를 살펴볼 수 있습니다. Vars와 Target을 바꿔도 현재 브라우저의 후보만 바뀌고 Demo 원본은 유지됩니다.

Calculation 탭에서 Demo의 Measurement와 RecordedData를 고르고, 기존 계산식을 수정하거나 새 로컬 초안을 만들어 결과를 미리 볼 수도 있습니다. 일반 사용자의 편집은 현재 Workbench에만 남습니다. 탭을 떠날 때 편집 폐기를 확인하며, 새로고침하면 원본으로 돌아갑니다.

Demo 원본의 **Save & Run**, Simulation, 누락 데이터 계산, Measurement·Calculation 저장과 삭제는 관리자만 할 수 있습니다. 일반 Experiment의 저장·실행에는 로그인과 해당 작업의 소유권 또는 관리자 권한이 필요합니다. **Edit a copy**는 소스 묶음만 새 로컬 Draft로 복사합니다. 원격 ID, Measurement, Calculation과 Demo의 저장 데이터 연결은 복사하지 않습니다.

## 예측 방향과 화면 읽기

### 마지막 편집이 예측 방향을 정합니다

- 왼쪽 Vars를 편집하면 **Forward**가 됩니다. kNN으로 RecordedData를 예측한 뒤 선택한 Calculation의 저장된 계산식을 브라우저에서 실행해 오른쪽 결과를 갱신합니다.
- 오른쪽 Forward 결과를 처음 편집하면 전체 결과가 목표값(Target) 초안이 되고 **Inverse**로 바뀝니다. 선택한 목표값 전체에서 Vars를 예측해 후보와 Viewer에 한 번에 반영합니다. 입력한 Target은 유지하고, 찾은 조건을 Forward에 다시 넣은 결과도 계산합니다. 저장된 Measurement를 Target으로 불러오는 선택기는 없으므로 현재 Forward 결과를 편집해 시작하세요.
- 연속된 편집은 잠시 모아 처리하며 이전 요청이 늦게 끝나도 최신 결과를 덮어쓰지 않습니다. Inverse가 Vars를 바꾸었다는 이유만으로 Forward 방향으로 전환되지는 않습니다. 리본의 **Direction**과 상태를 확인하고 필요하면 **Cancel**로 중단하세요.

Vars 편집기는 위쪽 값 편집 영역(기본 60%)과 아래쪽 목록(40%)으로 나뉩니다. 구분선을 드래그하거나 방향키로 높이를 조절할 수 있습니다. Measurement와 같은 스칼라·벡터 슬라이더, 텐서 셀 선택·일괄 편집·단면 선택·가상 스크롤을 사용합니다. 선택한 변수의 **Sampling Min/Max**와 **Reset**은 위쪽에 있습니다.

Enter나 포커스 이동으로 유효한 입력을 확정하면 후보에 반영합니다. 미확정·잘못된 입력이 있으면 Save & Run과 Sampling을 사용할 수 없습니다. Experiment나 변수 규격이 바뀌면 선택과 편집 초안을 초기화합니다.

### 예측값과 실제값 구분하기

| 표시 | 색상 | 의미 |
| --- | --- | --- |
| **Predicted** | 파랑 | 현재 변수로 예측한 결과 |
| **Target** | 주황 | 직접 입력한 목표 결과 |
| **Re-predicted** | 보라 | Inverse로 찾은 변수를 Forward에 다시 넣은 결과 |
| **Save + Run Actual** | 초록 | Save & Run으로 실제 계산한 결과 |

비교용 결과는 읽기 전용입니다. 포인터를 올리거나 범례를 확인하는 것만으로 예측 방향이 바뀌지 않습니다. 스칼라는 같은 수치축의 표시로, 1차원 결과는 겹친 선으로 비교합니다. 2차원 결과는 같은 축과 색상 범위의 Heatmap을 나란히 배치합니다. 같은 셀을 가리키면 모든 Heatmap에서 좌표와 값을 함께 강조하며, 좁은 화면에서는 가로 스크롤로 읽기 좋은 크기를 유지합니다.

각 카드의 **Display range**는 새 Forward 기준 결과가 들어올 때 최솟값·최댓값에 5% 여백을 더해 맞춘 뒤 고정합니다. Target 편집이나 Inverse 실행, 비교 결과 도착만으로 범위를 바꾸지 않습니다. **Fit**을 누르면 현재 기준 결과와 준비된 호환 비교 결과 전체에 다시 맞춥니다. 범위를 벗어난 셀은 양 끝 색으로 표시하고 `clipped` 개수를 안내하지만 실제 데이터와 허용 자료형 범위는 바꾸지 않습니다.

Target Heatmap에서 선택한 사각형은 목표값 확정, Inverse 실행, 비교값 갱신과 Fit 후에도 유지됩니다. 새 Forward 기준 결과로 교체되거나 dtype·shape·axes가 바뀔 때만 초기화됩니다.

### Prediction Viewer

Vars를 바꾸면 마지막 정상 예측을 보여 주면서 갱신 중이라고 안내합니다. 현재 조건의 Forward RecordedData가 준비되면 Calculation이 끝나기 전에도 Box Grid 결과를 바꿉니다. 선택한 Calculation에 필요한 Record만 예측하며, 형상을 겹칠 때는 소스와 Vars가 결과에 일치하는 형상만 사용합니다. Inverse로 찾은 조건도 같은 방식으로 표시하고 입력한 Target은 유지합니다.

형상이 필요 없는 보기에서는 Record 규격과 현재 조건의 Box Grid 위치·크기·변환·격자 정보만 준비합니다. 필요한 선언 함수와 메타데이터는 해석하지만 전체 CAD 평가와 JSCAD 입체·불리언 연산, Manifold 표시 메쉬 생성과 형상 렌더링은 생략합니다. Geometry 보기나 겹치기를 켜면 최신 후보의 형상을 준비하고, 같은 입력의 준비 결과는 재사용합니다. **Save & Run**에서는 보기 설정과 관계없이 실행에 필요한 전체 평가·재료 검증·빌드를 수행합니다.

처음에는 Viewer의 기본 규칙에 따라 Box Grid를 선택합니다. 이후에는 선택한 데이터나 Geometry, 표시 설정과 카메라를 유지합니다. 갱신 중 Geometry를 골랐다면 예측이 도착해도 그대로 표시합니다. Prediction은 현재 예측 대신 다른 저장 Measurement나 임시 Preflight 결과를 보여 주지 않습니다.

Calculation이 실패해도 성공한 Box Grid 예측은 남습니다. 예측이 실패하거나 취소된 뒤, 또는 Experiment나 탭을 바꾼 뒤에 늦게 도착한 응답은 표시하지 않습니다.

### Settings와 cohort

**Prediction Settings**에서 한 개 이상의 저장된 Calculation, 계산식별 거리 가중치, 사용할 이웃 수 k의 **Auto/Manual**, **Neighbor weighting**을 고른 뒤 **적용**합니다. 설정을 편집하는 동안에는 현재 모델이 바뀌지 않습니다. 출력 규격의 사전 검증이 없는 Calculation은 선택할 수 없으므로 Calculation 탭에서 검증해 다시 저장하세요.

계산식을 선택하면 저장된 출력 규격으로 오른쪽 카드와 축을 먼저 준비합니다. 값이 도착하기 전에는 편집할 수 없는 **Updating…** 상태입니다. **새로고침**은 최신 Measurement와 CalculationData를 읽고, **누락 데이터 계산**은 선택한 Calculation의 빠진 결과를 계산한 뒤 다시 불러옵니다. 공개 Demo의 새로고침과 Model Details는 누구나 사용할 수 있지만, 누락 데이터 계산에는 관리자 권한이 필요합니다.

**cohort**는 같은 모델에서 함께 학습할 수 있는 데이터 묶음입니다. Forward는 선택한 Calculation이 참조하는 Box Grid RecordedData만 읽습니다. 여러 계산식이 같은 Record를 쓰면 한 번만 다운로드하고 학습하며, 관련 없는 Record는 배열을 펼치거나 메모리 사용량을 계산할 때 포함하지 않습니다.

각 Record는 7차원 텐서 전체를 예측합니다. shape·dtype·물리 단위·채널과 성분 순서·정적 Box Grid 정보·시간과 주파수 좌표가 같은 표본을 묶고, 표본이 가장 많은 묶음을 사용합니다. 동률이면 가장 낮은 Measurement ID를 포함한 묶음을 고릅니다. Box의 위치·크기·회전과 x/y/z 좌표는 Box 안의 상대 위치로 대응하므로 달라도 사용할 수 있습니다. 한 Record와 맞지 않는 표본이 제외되어도 다른 Record의 학습 데이터까지 줄이지는 않습니다.

예측 텐서에는 현재 후보에서 다시 구한 Box 형상과 셀 중심 x/y/z 좌표를 붙여 Calculation에 전달합니다. 과거 Measurement의 Box 위치를 그대로 복사하지 않습니다. 필요한 Record 모델이 없는 Calculation에만 오류를 표시하고 나머지 결과는 유지합니다. **Settings**와 **Model Details**에서 계산식별 참조와 Record별로 포함·제외한 Measurement를 확인하세요.

모드 해석은 예외적으로 표본마다 고유주파수가 달라도 됩니다. 같은 Task의 모든 모드장과 실제 고유주파수 좌표를 하나의 최근접 Measurement에서 일관되게 가져오며 고유벡터를 평균하지 않습니다. Inverse는 선택한 Calculation의 저장된 출력 규격을 기준으로, 필요한 값이 모두 있는 표본들의 교집합을 사용합니다.

### 모델 설정과 갱신 확인하기

Console의 source를 **Prediction**으로 선택하면 shape 불일치로 제외된 Record와 모델 실패를 확인할 수 있습니다. 모델의 변경 식별값에는 ExperimentRecord 규격과 Calculation의 참조·소스·출력 규격이 포함됩니다. 이들이 바뀌면 이전 모델과 예측·검증 결과를 오래된 상태로 처리합니다.

Measurement, RecordedData 또는 CalculationData가 바뀌면 학습 입력과 Worker의 모델 캐시를 자동으로 다시 만들고 현재 Forward 또는 Inverse 방향을 재계산합니다. 자동 갱신에 실패한 경우에는 갱신이 필요하다는 안내와 **새로고침**이 남습니다.

**Auto k**는 학습 행 수 `n`에 대해 `round(sqrt(n))`을 사용하되 1~15와 실제 데이터 묶음 크기 안으로 제한합니다. **Manual k**는 1~`n`의 정수입니다. **Distance**는 가까운 이웃에 더 큰 가중치를 주고, **Uniform**은 선택된 이웃을 같은 비중으로 평균합니다. 거리는 Forward에서 varsSchema 범위로, Inverse에서 학습 데이터의 표준편차로 정규화합니다.

모델은 브라우저의 Prediction Worker에서 Float64 배열로 계산합니다. 원본을 PCA나 요약값으로 대체하지 않습니다. 복소수는 진폭·위상을 실수부·허수부로 바꾸어 이웃을 가중 평균한 뒤 다시 복원합니다. 진폭이 0이면 위상도 0이며, 위상 각도를 직접 평균하지 않습니다.

모델당 수치 원소 **1천만 개**, 유지하는 배열 **192 MiB**, 전체 작업 메모리 **256 MiB**가 상한입니다. 하나라도 넘으면 모델을 만들지 않고 메모리 오류를 표시합니다. 선택한 Calculation 수나 텐서 크기를 줄이고 새로고침하세요. 실제 사용량은 **Model Details**에서 확인할 수 있습니다.

### Farthest Sample & Run

더 다양한 조건의 실제 결과가 필요할 때 **Sample & Run**을 사용합니다. 기존에 계산한 조건에서 멀리 떨어진 후보를 골라 탐색 범위를 넓혀 줍니다.

1. 선택한 Vars 위쪽의 **Sampling Min/Max**로 허용 범위 안에서 탐색 구간을 정합니다. 텐서 변수는 모든 셀에 같은 최솟값·최댓값을 사용합니다.
2. 리본의 **N**에 시도 횟수를 입력합니다. N은 성공 횟수가 아니며 양의 JavaScript 안전 정수여야 합니다.
3. **Sample & Run**을 누르고 준비·업로드·서버 실행·후처리 진행 상태를 확인합니다.

탐색 범위는 저장되지 않으며 Experiment나 varsSchema가 바뀌면 초기화됩니다. 알고리즘은 선택 범위 안에서 중복을 제거한 Recorded Measurement를 기준점(center)으로 사용합니다. 기준점이 없으면 범위의 정중앙에서 시작합니다. 이후에는 정규화한 Vars별 평균제곱거리를 균형 있게 사용해 먼 후보를 고르는 결정적 farthest-point/k-center 근사를 적용합니다.

후보 N개를 차례로 준비하고, 준비에 성공한 후보를 이번 실행의 임시 기준점에 추가합니다. 각 후보의 Vars로 `material.tsx`를 다시 평가하며 현재 화면의 후보는 바꾸지 않습니다. 준비에 실패하면 집계한 뒤 다음 시도를 계속하고, 성공한 후보만 한 서버 CAE 배치로 제출합니다. 모두 실패했다면 제출하지 않습니다.

서버가 시뮬레이션과 RecordedData 저장을 수행하고, 브라우저가 성공한 Measurement의 CalculationData를 계산합니다. 개별 계산의 실패가 다른 후보 처리를 막지는 않습니다. CAE Jobs에서도 작업을 확인할 수 있습니다.

**Cancel**은 준비와 후처리를 중단하고 이미 등록된 배치의 취소를 요청합니다. Experiment나 소스를 바꾸면 현재 화면에서 진행하던 처리를 분리합니다. 이미 제출된 서버 작업은 CAE Jobs에서 관리하세요. 브라우저를 닫아도 제출된 시뮬레이션은 계속되지만 후처리는 브라우저가 필요합니다. 빠진 CalculationData는 **누락 데이터 계산**이나 Calculation의 **All Missing**으로 보완할 수 있습니다.

배치가 끝나거나 취소·중단된 뒤 저장된 점이 있으면 모델을 한 번 자동 갱신합니다. 서버에서 나중에 실패한 후보도 이번 실행의 임시 기준점에는 포함되지만, 다음 실행은 실제 Recorded Measurement로 기준점을 다시 구성합니다.

### Save & Run 검증

예측과 실제 계산의 차이를 확인하려면 **Save & Run**을 사용하세요. 최신 예측이 현재 후보와 일치하고, Experiment를 저장한 뒤 소스를 수정하지 않은 상태여야 합니다.

실행을 시작하면 현재 예측값과 후보 버전을 비교 기준으로 고정합니다. 현재 Vars를 새 Measurement로 저장한 뒤 실제 시뮬레이션, RecordedData 저장, 저장된 Calculation의 자동 계산을 수행합니다. 결과는 기존 Calculation Data 카드에 나타나며 세부 정보 창은 자동으로 열리지 않습니다. 더 자세히 보려면 **Model Details**를 누르세요.

Forward에서는 **Predicted ↔ Actual**, Inverse에서는 **Target ↔ Re-predicted**, **Target ↔ Actual**, **Re-predicted ↔ Actual**을 각각 비교합니다. 차원 수와 각 차원의 길이(shape)가 같은 조합에 대해 평균 절대 오차(MAE), 제곱근 평균 제곱 오차(RMSE), 최대 절대 오차를 카드와 Model Details에 표시합니다.

유효한 숫자 텐서는 dtype·축 이름·단위·좌표가 달라도 shape가 같으면 같은 배열 인덱스끼리 비교합니다. 겹쳐 표시할 때는 Predicted 또는 Target의 축을 쓰며, 원본 좌표를 보존하고 보간이나 단위 변환은 하지 않습니다.

비교 결과의 shape가 기준과 다르면 같은 카드 안에 원래 shape와 좌표로 따로 표시합니다. 기준과 실제 크기를 안내하고 해당 쌍의 겹치기와 오차 계산만 중단합니다. 소스가 일치하지 않거나 텐서가 잘못된 경우에는 정상 결과로 표시하지 않습니다. 시뮬레이션·저장·후처리 실패나 취소는 검증 실패로 표시하며, 실제 CalculationData가 없는 항목에는 개별 오류를 보여 줍니다.

성공하면 새 Measurement를 포함해 모델을 자동 갱신하고 현재 방향을 다시 예측합니다. 다만 카드에는 실행 시작 시점의 Predicted 또는 Target·Re-predicted와 완료된 Actual 비교를 그대로 남깁니다. Vars·Target·Prediction Settings·Experiment·소스·출력 규격을 바꾸거나, 수동으로 데이터를 다시 불러오거나, 새 Save & Run을 시작하면 이 비교 기준을 해제합니다.

Measurement에서 후보를 직접 고르는 방법은 [Measurement 사용법](workbench-measurement.md)에서 확인할 수 있습니다. Prediction의 Sample & Run은 위의 최대 거리 선택 방식을 사용하며 별도 알고리즘 선택 창은 없습니다. 실행 입력과 큰 결과는 S3로 전달하고, 서버 배치 실행 후 브라우저에서 후처리를 수행합니다.
