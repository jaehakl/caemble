# CAE Workbench 빠른 시작

Caemble의 Experiment는 공통 형상과 변수, Material, solver Task, 실행 프로그램과 RecordedData 계약을 하나의 source bundle로 관리합니다.

## 시작 페이지와 Showcase

`/`에 접속하면 로그인 상태에서는 `/workbench`, 비로그인 상태에서는 `/showcase`로 이동합니다. 두 주소는 로그인 여부와 관계없이 직접 열 수 있습니다. 특정 저장 버전은 `/workbench?experiment=ID`로 바로 엽니다. 기존 `/?experiment=ID`와 `/?help=...` 링크도 Workbench로 연결됩니다.

Showcase는 접근 가능한 저장 Experiment와 공개 Demo를 4:3 이미지 카드로 표시합니다. 첫 진입 시 대표 Demo를 선택하며, 카드 선택 시 오른쪽 Viewer에서 형상과 가장 최근 기록 완료 Measurement를 확인할 수 있습니다. Showcase 탐색은 Workbench의 로컬 작업을 변경하지 않습니다. Catalog 예제는 Workbench 리본의 **Examples**에서 엽니다.

같은 namespace·Repository·key의 버전은 최신 버전 카드 하나로 묶입니다. 카드 하단 우측의 버전 배지를 누르면 이전 버전을 선택할 수 있습니다. 이름·설명·key 검색, Repository 다중 필터, 생성일·이름·Measurement 수 정렬을 지원하며 기본은 생성일 최신순입니다. 생성일과 Measurement 수는 대표 버전 기준이며 이전 버전의 수를 합산하지 않습니다.

카드 상단의 편집 버튼은 해당 버전을 선택한 Workbench로 이동합니다. 삭제 권한이 있는 카드의 삭제 버튼은 해당 버전만 삭제하며 연결 데이터도 확인합니다. 썸네일이 없거나 불러올 수 없으면 기본 대표이미지를 표시합니다. Workbench에서 저장하면 현재 Viewer 화면으로 썸네일을 만들 수 있습니다.

## Workbench 진입

복원할 로컬 작업이나 URL로 지정한 Experiment가 없으면 **Experiment** 화면에서 첫 namespace의 첫 Experiment를 자동으로 엽니다. 저장된 Experiment가 없으면 첫 예제를 엽니다. 기존 로컬 작업과 저장된 선택은 재방문 시 복원됩니다.

저장된 Experiment를 열면 결과가 기록된 Measurement 중 가장 최근 항목을 자동으로 불러옵니다. 해당 Measurement의 Vars·Material과 RecordedData가 적용되고 ray 경로 등 지원되는 결과가 Viewer에 표시됩니다. 기록된 결과가 없으면 Experiment만 표시하며 Solver를 자동 실행하지 않습니다.

## Experiment 레이아웃과 불러오기

Experiment 탭은 왼쪽 Viewer, 오른쪽 코드 편집기로 나뉘며 기본 너비는 50:50입니다. 가운데 구분선을 드래그하거나 포커스 후 방향키로 크기를 조절합니다. Viewer 확대와 하단 Console은 계속 사용할 수 있습니다. 다른 탭 레이아웃은 유지됩니다.

리본의 **New**는 새 작업을 시작합니다. **Examples**는 이름·설명·좌표·버전을 한 행씩 표시하는 검색 가능한 Catalog 목록입니다. 항목 선택 후 **적용**하면 소스와 Calculation 정의를 함께 가져옵니다.

**Load**에서는 Showcase 카드와 독립된 Viewer로 저장 버전과 최신 기록 완료 Measurement를 미리 봅니다. 버전 배지로 이전 버전도 선택할 수 있습니다. **불러오기**를 눌러야 Workbench에 적용하며 취소하면 현재 작업을 유지합니다. 미저장 편집이 있으면 교체를 확인하고, 실행 중에는 작업 교체가 제한됩니다.

## Measurement 탭

Measurement는 실행 입력을 만들고 구조·예측·실측을 확인하는 별도 탭입니다. 탭 순서는 Experiment → Measurement → Calculation → Prediction → Analysis입니다. 기존 Calculation 편집은 Calculation 탭에서 계속 사용합니다.

좌우 기본 비율은 50:50입니다. 왼쪽 위에는 Vars PCA, 아래에는 Vars 편집기가 표시됩니다. 오른쪽 영역의 맨 위에는 두 Viewer가 공유하는 데이터 선택·설정 툴바가 있고, 그 아래 왼쪽에는 구조와 Forward 미리보기, 오른쪽에는 실제 결과가 50:50으로 표시됩니다. 각 구분선은 드래그와 방향키로 조절합니다.

### Vars 편집

편집기 왼쪽의 동일 크기 버튼은 이름과 scalar 값, 또는 tensor의 shape·평균을 보여줍니다. 항목을 선택하면 오른쪽에 편집기가 열립니다.

- Scalar: 숫자 직접 입력과 수직 슬라이더를 사용합니다. 위쪽은 max, 아래쪽은 min입니다.
- 1D tensor: 원소별 숫자 입력·수직 슬라이더가 가로로 나열됩니다.
- 2D tensor: shape에 맞는 숫자 입력 Grid를 사용합니다.
- 3D 이상: 앞쪽 축의 인덱스를 선택하여 마지막 두 축의 단면을 편집합니다.

숫자는 Enter 또는 포커스 이동으로 확정하고 Escape로 되돌립니다. 미확정·잘못된 입력이 있으면 저장·Run이 비활성화됩니다. schema 범위를 벗어난 입력은 Vars에 반영하지 않습니다.

원소 인덱스를 클릭하여 선택하고 Ctrl/Cmd로 추가 선택, Shift로 범위 선택을 합니다. Grid에서는 인덱스를 드래그하거나 Shift+방향키로 사각 영역을 선택할 수 있습니다. **전체 tensor** 또는 **선택**에 대해 채우기·더하기·곱하기를 적용합니다. 하나라도 범위를 벗어나면 전체 작업을 반영하지 않습니다.

**Shuffle · 전체**는 선택한 tensor의 모든 원소를 min/max 범위에서 다시 무작위 생성합니다. 고차원 tensor의 보이지 않는 단면도 포함하며 다른 Var는 변경하지 않습니다. 편집과 Shuffle은 Solver를 실행하지 않습니다.

### PCA와 후보 생성

PCA는 Measurement와 후보의 Vars를 schema 범위로 정규화하여 분석하며 경계 가상점을 추가하지 않습니다. 점을 클릭하면 해당 Vars를 선택합니다. 빈 공간을 클릭하면 PCA 거리 기준 최대 7개 이웃의 Vars를 거리 역수로 평균하고, PC1·PC2를 클릭 좌표로 이동시켜 후보를 만듭니다. 범위를 벗어나면 보정된 위치를 표시합니다.

편집 중에는 PCA 축과 이웃을 고정하므로 같은 위치를 반복 클릭해도 Vars가 누적 변경되지 않습니다. **PCA 갱신**은 편집값을 분석에 반영합니다. 분산이 없는 경우 먼저 후보를 생성합니다.

**Random**은 범위 내 균등 난수로 N개 후보를 만듭니다. **빈 구간 LHS**는 각 성분에서 기존 Measurement와 후보가 차지한 구간을 제외합니다. 빈 구간이 N개 미만이면 분할을 늘려 고르게 생성합니다. 기본 N은 10입니다. 생성 후 후보를 선택하여 구조를 확인하고 **선택 Run** 또는 **전체 후보 Run**을 누릅니다. **후보 추가**는 현재 편집값을 후보 목록에 넣습니다.

후보는 탭 이동 동안 유지됩니다. 새로고침 후에도 남기려면 **Prepared 저장**을 사용합니다. Run은 검토한 Vars를 그대로 제출하며 Prepared Measurement는 기존 ID로 실행합니다. Recorded Measurement는 재실행하지 않습니다. 실패·취소 상태는 후보에서 확인합니다.

### Forward와 실제 결과 비교

**Forward 모델 생성**과 **모델 업데이트**는 수동 작업입니다. 생성한 모델이 있으면 Vars 변경 후 예측만 자동으로 갱신합니다. 새 데이터가 생겨도 자동 학습하지 않으며 업데이트 필요 상태를 표시합니다. 모델은 탭 이동 동안 유지하고 새로고침·Experiment/source/schema/사용자 변경 또는 Worker 소실 시 다시 생성해야 합니다.

Forward는 기존 숫자형 Box Grid RecordedData를 지원합니다. 다른 형식은 실제 결과를 조회할 수 있으며 예측 미지원 사유를 표시합니다. CalculationData 편집과 파생 결과 분석은 기존 탭을 사용합니다.

Recorded Measurement를 선택하면 실제 결과 Viewer의 비교 기준이 됩니다. Vars를 수정해도 해당 실측과 실행 당시 구조·재료는 유지하며 현재 Vars와 다름을 표시합니다. 데이터 항목·시각화 방식·성분·축·집계·단면·Overlay·재생 설정은 공통 툴바에서 함께 조절하고, 카메라는 독립적으로 조작합니다. 자동 색상 범위는 각 Viewer의 데이터에서 계산하며 직접 고정한 범위는 양쪽에 동일하게 적용합니다.

Vars 조절로 Forward 결과가 갱신되거나, 실측을 교체하거나, 모델을 업데이트해도 설정과 카메라는 초기화되지 않습니다. 로딩·오류·데이터 누락 중에도 설정을 보존하고, 재생은 갱신 중 위치를 유지했다가 이어갑니다. 항목별 설정은 다른 항목을 보고 돌아오거나 탭을 이동해도 유지됩니다. 새 데이터의 shape에 적용할 수 없는 성분·단면·프레임은 자동 보정하지 않고 해당 Viewer에 이유를 표시하므로 공통 툴바에서 수정하세요. 새 작업공간·Experiment를 열거나 페이지를 새로고침하면 새 세션 기본값을 사용합니다.

## Save와 Save As

- **Save**: Draft이면 Save As를 엽니다. 저장된 Experiment는 서버의 최신 사용량을 확인하여 Measurement가 없으면 덮어쓰고, 하나라도 있으면 해당 Experiment를 대상으로 Save As를 엽니다. 읽기 전용 항목은 Save As로 복사합니다.
- **Save As**: 기본은 새 Experiment입니다. 기존 작업의 key에는 `-copy`를 제안합니다. 같은 저장 위치의 key가 이미 있으면 다른 key를 입력하거나 왼쪽 카드를 선택하세요.
- 왼쪽의 쓰기 가능한 카드를 선택하면 저장 대상의 namespace·Repository·key가 고정됩니다. 현재 소스·이름·설명·Viewer는 그대로 유지됩니다. 대상 계열의 최신 버전에서 Patch(기본), Minor 또는 Major를 증가시킵니다. 기존 대상의 Calculation 정의를 계승하며 새 Experiment는 현재 작업의 Calculation 복사 정책을 따릅니다.
- 저장 후에도 모달은 열려 있고 저장된 카드가 선택됩니다. Workbench 선택과 URL도 갱신됩니다. **닫기**로 종료합니다. 동시 변경으로 저장이 거부되면 갱신된 목록과 사용량을 확인한 후 다시 저장하세요.

Save As를 열 때 Viewer의 Geometry·결과 표현·범례를 고정 이미지로 캡처합니다. 툴바와 메뉴는 제외합니다. 큰 Preview 위의 4:3 사각형을 드래그해 이동하고 우측 하단 핸들로 크기를 조절하세요. 처음에는 중앙 최대 영역이 선택됩니다. 키보드로는 사각형에 포커스한 뒤 방향키로 이동하고, 핸들에 포커스한 뒤 오른쪽·아래 방향키로 확대하거나 왼쪽·위 방향키로 축소합니다. Shift를 함께 누르면 조절 폭이 커집니다. 직접 Save도 중앙 최대 영역을 사용합니다. 저장 형식은 최대 640×480 WebP, 512KiB입니다. 빈 화면이나 캡처 실패 시 이유를 표시하며, 덮어쓰기는 기존 이미지를 유지하고 신규 저장은 기본 이미지를 사용합니다.

완료된 유효한 Preflight가 있으면 **Preflight 결과 함께 저장**이 기본으로 켜집니다. 리본과 Save As에서 같은 옵션을 사용합니다. 저장 소스·결과 계약이 실행 당시와 일치해야 하며 본인 소유의 성공 결과만 24시간 안에 저장할 수 있습니다. 만료되거나 불일치하면 다시 실행하거나 포함 옵션을 해제하세요.

함께 저장한 Preflight는 Solver 재실행 없이 기록 완료 Measurement가 됩니다. 실행 당시 Vars·Material·Geometry·RecordedData·시각화·실행 추적과 저장 객체를 독립적으로 보존하므로 임시 결과의 만료 정리와 다른 저장본 삭제에 영향을 받지 않습니다. 서버 저장이 성공하면 새 Measurement를 선택하고 임시 Preflight 표시를 영구 결과로 전환합니다.

## 먼저 준비할 것

형상과 문서는 로그인 없이 살펴볼 수 있습니다. 서버에 Measurement를 저장하고 Solver를 실행하려면 로그인과 사용 가능한 내 CAE Launcher가 필요합니다. 실행 전에 **Setting → Launchers**에서 연결 상태를 확인하세요.

## 첫 실행의 목표

| 단계      | 할 일                                           | 확인할 결과                                                  |
| --------- | ----------------------------------------------- | ------------------------------------------------------------ |
| 작성      | Experiment에서 예제를 열고 Source를 확인합니다. | source 상태가 `Ready`이고 Viewer에 형상이 보입니다.          |
| 조건 확인 | Vars와 Material Parameter를 확인합니다.         | 원하는 Candidate의 형상과 값이 일치합니다.                   |
| 저장·실행 | Measurement를 준비하고 실행합니다.              | CAE Jobs에 작업이 등록되고 Console에 진행 상태가 표시됩니다. |
| 결과 확인 | 완료된 Measurement를 선택합니다.                | RecordedData가 표시되고 Calculation에서 계산할 수 있습니다.  |

## 순서대로 진행하기

1. 로그인하고 CAE Launcher가 연결되어 있는지 확인합니다.
2. 상단 **Experiment** 메뉴를 선택하고 **Load**로 저장 버전을 불러오거나 **Examples**에서 예제를 적용한 뒤, 오른쪽 Source 탭에서 source bundle을 작성합니다.
3. source 상태가 `Ready`가 될 때까지 compile/evaluate 오류를 해결합니다.
4. **Generate Candidate**로 `varsSchema` 범위의 새 변수 조건과 그 조건에서 만든 Model Parameter를 미리 봅니다.
5. 원하는 조건이면 **Save Current Measurement**로 변수와 Material snapshot을 고정합니다. 이 단계는 solver를 실행하지 않습니다.
6. 상단 **Calculation** 메뉴의 왼쪽 점 배열에서 prepared Measurement를 선택합니다. Ctrl/Cmd+클릭으로 여러 항목을 선택하고 Shift+클릭으로 현재 페이지의 범위를 선택할 수 있습니다.
7. **Generate & Run**은 브라우저에서 새 Candidate와 실행 입력을 build한 뒤 서버에 batch로 제출합니다. **Save & Run**은 화면에서 확인한 Vars와 Material snapshot을 그대로 고정하여 build합니다.
8. 횟수를 입력하고 **Sample & Run**을 누르면 Vars 범위에서 Monte Carlo(random) 방식으로 후보를 뽑고, 브라우저에서 모든 실행 입력을 먼저 build한 뒤 한 번의 batch로 제출합니다. Prediction의 Sample & Run은 기존 LHS 후보 선택 방식을 사용합니다. 기본값은 10이며, N은 성공 횟수가 아니라 전체 시도 횟수입니다. 서버가 사용 가능한 내 Launcher에 작업을 하나씩 배분합니다.
9. build와 업로드가 끝나 서버 접수가 완료되면 브라우저를 닫아도 CAE 계산은 계속됩니다. 로컬 build나 업로드 중에는 브라우저를 유지하세요. 작업별 진행률과 완료·실패 알림은 **Console**에 표시됩니다. **Setting → CAE Jobs**에서 배치 목록과 오류를 확인하고 실패한 작업을 명시적으로 재시도할 수 있으며, **Batch 취소**는 아직 끝나지 않은 작업을 취소합니다.
10. 기존 Prepared Measurement는 **Run**으로 실행합니다. 실행이 실패한 작업은 **CAE 작업**에서 재시도하세요. 서버나 worker 연결 중단을 포함한 실패는 자동으로 다시 실행하지 않습니다.
11. CAE worker가 큰 결과 본문을 S3에 직접 업로드하고 서버에 RecordedData 참조가 원자적으로 저장되면 Measurement는 Recorded 상태가 됩니다. 선택 중인 Measurement의 결과는 서버 완료 이벤트를 받은 뒤 즉시 다시 불러옵니다.

큰 BuiltMeasurement와 결과 본문은 Client ↔ S3 ↔ Slave 경로로 전달됩니다. 브라우저는 결과를 S3에서 직접 읽고, 서버는 권한·참조·작업 상태를 관리합니다.

## 실행 전후에 기억할 점

Measurement는 immutable Experiment revision을 가리킵니다. 생성 요청의 source hash가 현재 revision과 다르면 저장이 거부되므로, source가 바뀌면 새 revision에서 새 Measurement를 준비하세요.

Task 파일이 하나도 없는 Experiment도 Geometry preview와 Experiment 저장은 사용할 수 있습니다. 이 경우 Measurement 생성·선택·분석과 Simulation 실행은 Task를 추가할 때까지 비활성화됩니다.

## 다음 단계

- source가 준비되지 않으면 [Ready 문제 해결](../troubleshooting/troubleshooting-ready.md)을 확인하세요.
- 실행 후에는 [Calculation으로 결과 계산](workbench-calculation.md)을 이어서 진행하세요.
- 정확한 문법이나 완성 예제는 Help의 **Geometry**, **Solver**, **Examples**에서 찾을 수 있습니다.
