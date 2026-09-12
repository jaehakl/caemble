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
