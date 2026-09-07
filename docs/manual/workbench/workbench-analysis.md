# Analysis: Explore, Mining과 Data

**Analysis**는 현재 Experiment에서 CalculationData가 하나 이상 저장된 Measurement만 분석합니다. Measurement의 숫자 input vars와 Material parameter는 feature로 유지하고, 저장된 CalculationData만 target으로 사용합니다. RecordedData는 Analysis에서 조회하거나 사용하지 않습니다. 중앙 3D Viewer와 Console은 그대로 유지되며, 오른쪽 Analysis 결과와 왼쪽 탭별 설정은 각각 스크롤할 수 있습니다.

### Explore

Analysis에 들어오면 사용할 수 있는 숫자 input vars와 숫자 CalculationData target의 모든 조합을 계산합니다. scalar CalculationData는 원값을 사용하고 rank 1–2 결과는 모든 원소의 `mean`과 표본 `std` 열로 요약합니다. 원소가 하나인 tensor의 `std`는 0이며 빈 tensor는 결측값입니다. Material parameter는 기본 상관 순위에 포함하지 않습니다. `|Pearson r|`이 큰 순서로 정렬하고, 같으면 `|Spearman ρ|`와 안정적인 key 순서를 사용합니다. 1위 조합이 자동으로 선택되며 검색 가능한 두 선택기나 순위 행으로 다른 조합을 고를 수 있습니다.

Pearson과 Spearman은 완전한 input/target 값 쌍이 3개 이상이고 두 축이 상수가 아닐 때만 계산합니다. `n`은 실제 계산에 사용한 완전한 쌍의 수입니다. 산점도의 점에 포인터를 올리면 Measurement ID와 좌표를 확인할 수 있습니다.

### Mining

**Mining**은 2–50개 feature를 표준화해 PCA projection, 자동 K-Means, principal-component loadings와 reconstruction anomaly를 계산합니다. Explore 선택과는 독립적이며 검색, source 그룹, 전체 선택과 초기화를 사용할 수 있습니다.

### Data와 CSV

**Data**에는 histogram, scalar profile과 100행 데이터 표가 있습니다. 표와 **선택 데이터 CSV**는 Data 설정에서 선택한 feature 및 CalculationData 요약 열만 사용하며 CalculationData 원본 tensor 배열은 포함하지 않습니다.
