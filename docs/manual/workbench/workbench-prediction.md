# Prediction으로 Vars와 CalculationData 상호 예측

Workbench를 처음 열면 **Prediction**에서 시작합니다. 왼쪽 위 Experiment 선택기는 로그인 사용자의 **내 Experiment**를 먼저, 큐레이션된 **Demo**를 다음에 표시하며 비로그인 사용자는 대표 Demo가 자동으로 열립니다.

이후 새로고침에서는 브라우저 탭에 저장된 마지막 탭과 Experiment·Measurement·Calculation 선택을 다시 검증한 뒤, 여전히 현재 Experiment에 속하고 접근 가능한 선택만 복원합니다. 공유 URL은 `?experiment=ID`만 지원합니다. 탭과 Measurement·Calculation 선택은 URL에 저장하지 않으며, 기존 `section`, `measurement`, `calculation`, `structure`, `sample`, `setup` 파라미터는 적용하지 않고 자동으로 제거합니다.

상단 **Prediction** 메뉴는 현재 Experiment의 저장된 Recorded Measurement를 학습 데이터로 사용합니다. 왼쪽 **Vars**와 오른쪽 **Calculation Data** 사이의 중앙 3D Viewer 및 하단 Console은 다른 Workbench와 같은 상태로 유지됩니다. Demo의 Vars와 Target 조작은 로컬 Candidate에만 적용됩니다. Demo 원본과 저장 데이터는 guest와 일반 사용자에게 읽기 전용이며, admin에게만 관리 작업이 열립니다.

공개 Demo에서는 로그인하지 않아도 Forward Prediction, Inverse Design, Calculation 데이터 탐색, Analysis 그래프·표·CSV와 Experiment source를 볼 수 있습니다. Calculation 탭에서는 Demo의 Measurement 점과 RecordedData를 선택하고, 기존 Calculation source를 수정하거나 새 로컬 Draft를 만들어 Output을 즉시 미리볼 수 있습니다. Guest와 일반 사용자의 편집은 현재 Workbench에만 남고 원본 Calculation과 저장 데이터는 바뀌지 않으며, 탭을 떠날 때 폐기 확인 후 새로고침하면 원본으로 돌아갑니다. Demo 원본의 **Save & Run**, Simulation, 누락 데이터 계산, Measurement·Calculation 저장과 삭제는 admin에게만 허용됩니다. 일반 Experiment에서 이 작업들은 로그인과 기존 소유권 또는 admin 역할이 필요합니다. **Edit a copy**는 Experiment source bundle만 새 로컬 Draft로 복제하며 원격 ID, Measurement, Calculation과 공개 Demo 데이터 연결은 복제하지 않습니다.

### 마지막 편집이 예측 방향을 정합니다

- 왼쪽 Vars를 편집하면 **Forward**가 됩니다. `vars → RecordedData`를 kNN으로 예측한 뒤, 선택한 각 Calculation의 저장된 source를 브라우저에서 직접 실행해 오른쪽 CalculationData를 갱신합니다.
- 오른쪽의 Forward 결과를 처음 편집하면 전체 결과가 Target draft가 되고 **Inverse**가 됩니다. 선택한 CalculationData target 전체에서 vars를 kNN으로 예측하고, 완전한 vars 묶음을 한 번에 Candidate와 Viewer에 적용합니다. 입력한 target은 유지되며 Forward surrogate도 다시 계산합니다. 저장 Measurement를 Target으로 불러오는 selector는 없으며, Inverse는 현재 Forward 결과를 편집해서 시작합니다.
- 연속 편집은 잠시 모아 처리하며 이전 요청의 늦은 결과는 버립니다. Inverse가 적용한 vars 때문에 Forward가 다시 시작되지는 않습니다. 리본의 Direction과 상태를 확인하고, 오래 걸리는 작업은 **Cancel**로 중단할 수 있습니다.
- Prediction의 Vars도 Calculation과 같은 인라인 단일-open 카드입니다. Candidate 값이나 Inverse 결과가 갱신되어도 열린 카드는 유지되며 별도 팝업을 열지 않습니다.
- 오른쪽 편집기는 기준 데이터와 비교 시리즈를 한 화면에 표시합니다. Forward는 파란 **Predicted**와 초록 **Save + Run Actual**을, Inverse는 주황 **Target**, 보라 **Re-predicted**, 초록 **Save + Run Actual**을 사용합니다. 비교 시리즈는 읽기 전용이므로 hover나 legend 확인이 Prediction 방향을 바꾸지 않습니다.
- scalar는 공통 수치축 marker, 1-D는 공통 축의 line overlay로 비교합니다. 2-D는 동일 axes와 color scale을 공유하는 heatmap을 한 행에 병렬 배치하며, 같은 cell을 hover하면 모든 heatmap에서 좌표와 값을 함께 강조합니다. 좁은 패널에서는 가로 스크롤로 각 heatmap의 판독 크기를 유지합니다.
- 각 CalculationData 카드의 **Display range**는 새 Forward primary 결과가 들어올 때 실제 min/max에 5% 여백을 더해 한 번 맞춘 뒤 고정됩니다. Target 편집, Inverse, Re-predicted 또는 Actual 도착만으로는 다시 확대·축소하지 않습니다. **Fit**은 현재 primary와 ready 상태인 호환 비교 시리즈 전체로 범위를 다시 맞춥니다. 범위 밖 cell은 끝 색으로 표시하고 `clipped` 수를 알리지만 데이터 값이나 dtype 허용 범위를 변경하지 않습니다.
- Target heatmap의 선택 사각형은 Target commit, Inverse 시작·완료, Re-predicted·Actual 갱신과 Fit 뒤에도 유지됩니다. 새 Forward primary로 교체되거나 dtype, shape, axes가 바뀔 때만 선택을 초기화합니다.

### Settings와 cohort

리본의 **Prediction Settings**에서 한 개 이상의 저장된 Calculation, 각 Calculation의 거리 weight, k의 Auto/Manual 방식과 Neighbor weighting을 선택한 뒤 **적용**합니다. 성공한 preflight 계약이 없는 기존 Calculation은 선택할 수 없고 다시 저장해야 합니다. 설정 초안은 적용 전까지 현재 모델을 바꾸지 않습니다. Calculation을 선택하는 즉시 저장된 Output layout으로 오른쪽 카드와 shape·axes가 만들어지며 값이 도착하기 전에는 비편집 **Updating…** 상태입니다. **새로고침**은 최신 Measurement와 CalculationData를 다시 읽고, **누락 데이터 계산**은 선택한 Calculation의 미저장 조합을 계산한 뒤 데이터를 다시 불러옵니다.
공개 Demo의 새로고침과 Model Details는 누구나 사용할 수 있지만 누락 데이터 계산은 데이터 변경이므로 admin 역할이 필요합니다.

Forward는 선택한 Calculation dependency의 합집합에 해당하는 RecordedData만 조회합니다. 공유 ExperimentRecord는 한 번만 다운로드·모델링하고 관련 없는 Record는 flatten이나 메모리 계산에 포함하지 않습니다. 각 ExperimentRecord는 독립 kNN 모델을 가지며 numeric·finite runtime tensor를 정확한 shape별로 묶어 가장 큰 cohort를 사용합니다. 동률이면 가장 낮은 Measurement ID가 포함된 shape를 선택합니다. 따라서 Record A의 shape 불일치는 A 모델에서만 제외되고 Record B의 cohort나 다른 Calculation은 줄어들지 않습니다.

Forward 예측 결과는 ExperimentRecord 계약 metadata와 해당 Record의 dominant runtime shape로 Calculation 입력을 복원합니다. 필요한 Record 모델이 없는 Calculation만 오류가 되고 다른 Calculation 결과는 유지됩니다. Settings와 Model Details에서는 Calculation별 dependency, Record별 포함/shape 제외 Measurement와 선택 cohort shape를 확인할 수 있습니다. Inverse는 저장된 Calculation Output 계약을 기준으로 complete-case 교집합을 만들므로 dtype·shape·axes layout을 다시 추측하지 않습니다.

Runtime Console의 source를 **Prediction**으로 선택하면 Record별 shape 제외와 모델 실패를 확인할 수 있습니다. model fingerprint에는 ExperimentRecord contract hash, Calculation dependency·source hash·Output layout이 포함되므로 어느 계약이 바뀌어도 이전 모델, surrogate와 validation은 즉시 stale이 됩니다.
Measurement, RecordedData 또는 CalculationData가 바뀌면 Prediction은 변경된 fingerprint를 감지해 context와 Worker model cache를 자동으로 다시 만들고 현재 Forward 또는 Inverse 방향을 다시 계산합니다. 자동 갱신이 실패한 경우에만 stale 안내와 **새로고침**이 남습니다.

Auto k는 포함된 행 수 `n`에 대해 `round(sqrt(n))`을 사용하되 1–15와 실제 cohort 크기 안으로 제한합니다. Manual k는 1–`n` 범위의 정수만 허용합니다. **Distance**는 가까운 이웃에 더 큰 weight를 주고, **Uniform**은 실제 선택된 이웃을 동일하게 평균합니다. Forward 거리는 varsSchema 범위로, Inverse 거리는 cohort의 표준편차로 정규화됩니다.

회귀 모델은 브라우저 Prediction Worker의 Float64 배열에만 만들어지며 PCA나 summary 값으로 대체하지 않습니다. 모델 하나의 numeric cell은 **1천만 개**, persistent array는 **192 MiB**, 전체 working set은 **256 MiB**가 상한입니다. 하나라도 초과하면 모델을 만들지 않고 메모리 오류를 표시합니다. 이 경우 선택 Calculation 수를 줄이거나 RecordedData·CalculationData tensor 크기를 줄인 뒤 새로고침하세요. 실제 사용량은 **Model Details**에서 확인할 수 있습니다.

### Farthest Sample & Run

각 Vars 카드의 **Sampling Min/Max**는 schema 범위 안에서 탐색 범위를 추가로 좁힙니다. Tensor Vars는 모든 cell에 같은 Min/Max를 사용하고 이 범위는 Experiment 또는 varsSchema가 바뀌면 초기화되며 저장되지 않습니다. 리본의 N은 시도 횟수이며 양의 JavaScript safe integer여야 합니다.

**Sample & Run**은 선택 범위 안의 중복 없는 Recorded Measurement를 center로 사용합니다. 첫 center가 없으면 범위 정중앙에서 시작하고, 이후에는 정규화된 Vars별 평균제곱거리를 균형 있게 사용한 결정적 farthest-point/k-center 근사로 다음 후보를 고릅니다. N회 후보를 순차 준비하며, 준비에 성공한 후보를 이번 실행의 임시 center로 추가합니다. 각 후보의 Vars로 `material.tsx`를 다시 평가하고, 현재 화면의 Candidate는 바꾸지 않습니다. 준비 실패는 집계하고 다음 시도를 계속하며, 성공한 후보만 하나의 서버 CAE Batch로 제출합니다. 모두 실패하면 제출하지 않습니다. 서버는 각 후보의 Simulation과 RecordedData 저장을 실행하고, 브라우저는 성공한 Measurement의 CalculationData를 후처리합니다. 개별 Simulation 또는 Calculation 실패는 다른 후보의 처리를 막지 않습니다. 준비·업로드·서버 실행·후처리 진행 상태를 표시하며 기존 CAE Batch 화면에서도 작업을 확인할 수 있습니다. Cancel은 준비와 후처리를 중단하고 등록된 Batch의 취소를 요청합니다. Experiment 또는 source 변경은 현재 화면의 처리를 분리하며, 이미 제출된 서버 작업은 Batch 화면에서 관리합니다. 브라우저를 닫아도 제출된 Simulation은 계속되지만 Calculation 후처리는 브라우저가 필요합니다. 누락된 CalculationData는 기존 누락 계산 기능으로 보완하세요. Batch 종료·취소·중단 뒤 저장된 점이 있으면 모델을 한 번 자동 갱신합니다. 서버에서 나중에 실패한 후보도 이번 실행의 임시 center에는 포함되지만, 다음 실행의 center는 실제 Recorded Measurement로 다시 구성합니다.

### Save & Run 검증

최신 예측이 현재 Candidate와 일치하고 Experiment가 저장된 clean 상태일 때 리본의 **Save & Run**을 사용할 수 있습니다. 실행 시 현재 CalculationData와 Candidate revision을 비교 snapshot으로 고정하고, 현재 vars를 새 Measurement로 저장한 뒤 실제 Simulation, RecordedData 저장과 저장된 Calculation 자동 계산을 끝까지 수행합니다. 완료해도 Prediction 세부 정보 창을 자동으로 열지 않고 결과를 기존 Calculation Data 카드에 표시합니다. **Model Details**는 리본에서 사용자가 요청할 때만 엽니다. Forward에서는 Predicted와 실제 CalculationData를 겹쳐 비교합니다. Inverse에서는 Target과 그 Target으로 추론한 Vars의 Re-predicted를 먼저 비교하고, 실행이 끝나면 Save + Run Actual까지 더해 세 결과를 함께 비교합니다.

비교에는 rank와 각 차원의 길이(shape)가 같아야 하며, 호환되는 각 Calculation에 대해 MAE, RMSE와 최대 절대 오차를 오른쪽 카드와 **Model Details**에 표시합니다. Inverse에서는 Target↔Re-predicted, Target↔Actual, Re-predicted↔Actual을 각각 독립적으로 비교합니다. 유효한 숫자 tensor는 dtype·축 이름·단위·좌표가 달라도 shape가 같으면 같은 배열 인덱스끼리 비교합니다. 겹쳐 표시할 때는 Predicted 또는 Target의 축을 사용하며, 원본 좌표를 보존하고 보간이나 단위 변환은 하지 않습니다. Re-predicted 또는 Save + Run Actual의 shape가 기준 시리즈와 다르면, 같은 카드 안에 원래 shape와 좌표를 사용하는 읽기 전용 결과로 별도 표시합니다. shape의 기준값과 실제값을 안내하며, 해당 쌍의 겹치기와 오차 계산만 중단합니다. source 불일치와 잘못된 tensor는 정상 결과로 표시하지 않습니다. Simulation·저장·계산 실패나 Cancel은 검증 실패로 표시되고, 실제 CalculationData가 없는 대상은 개별 오류가 됩니다. 성공하면 새 Measurement를 포함하도록 모델을 자동 갱신하고 현재 방향을 다시 예측하지만, Calculation Data 카드에는 Save & Run을 시작한 시점의 Predicted 또는 Target·Re-predicted와 완료된 Actual 비교 snapshot을 유지합니다. 이 snapshot은 Vars·Target·Prediction Settings·Experiment·source/layout을 변경하거나 수동으로 데이터를 다시 불러오거나 새 Save & Run을 시작할 때 해제됩니다.
