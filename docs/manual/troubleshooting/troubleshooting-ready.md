# 소스가 Ready 상태가 되지 않을 때

`Ready`는 현재 소스의 검증과 형상·입력 평가가 끝났다는 뜻입니다. 오류가 여러 개 보여도 먼저 표시된 오류 하나부터 해결해 보세요. 나머지는 같은 원인에서 이어진 오류일 수 있습니다.

## 증상과 확인 위치

소스를 수정한 뒤 `Ready`가 되지 않으면 **Experiment → Source의 diagnostics**를 확인하세요. 파일명, 줄(line), 열(column)과 첫 오류 메시지가 출발점입니다. Ready인데 실행 버튼만 비활성화되었다면 로그인·저장·Vars 입력 상태도 확인합니다.

| 증상                     | 비교할 정보                   | 해결 방법                                             |
| ------------------------ | ----------------------------- | ----------------------------------------------------- |
| import·export·TSX 오류 | 표시된 파일명과 줄 번호 | 현재 API 참조와 Geometry 문법에 맞춰 수정합니다. |
| Vars·shape 오류 | `varsSchema`와 실제 후보값 | 스칼라·텐서 선언과 값의 배열 크기를 일치시킵니다. |
| Material 검증 오류 | Material Model의 필수 값·단위 | 모델의 입력 규격을 확인하고 빠진 값을 채웁니다. |
| Surface·ID 오류 | 형상 ID와 면 번호 | 중복 ID와 범위를 벗어난 면 참조를 수정합니다. |

## 해결 순서

1. 첫 오류가 가리키는 파일과 줄을 열고 메시지를 읽습니다. 위치를 제공하지 않는 오류라면 표시된 설명부터 확인하세요.
2. 공개 API를 `@caemble/core`에서 가져오는지, 파일 종류에 맞는 default export를 사용하는지 확인합니다.
3. TSX 태그와 속성 이름을 [Geometry 카탈로그](/doc?help=geometry)의 문법과 비교합니다.
4. `varsSchema`의 min/max와 텐서에 필요한 shape를 확인합니다. 실제 후보값의 배열 크기가 맞는지, Geometry ID가 중복되거나 그룹에 잘못 들어가지 않았는지도 살펴봅니다.
5. 면 그룹의 참조가 `<geometry-id>/surface/<non-negative-index>` 형식인지 확인합니다. 마지막 번호는 0 이상의 정수이며 해당 기본 형상의 고정된 면 번호 범위 안에 있어야 합니다.
6. 모델 ID, 필수 파라미터, 자료형(dtype), 단위(unit)와 텐서 크기를 [Material Model 카탈로그](/doc?help=materials)와 비교합니다.

소스를 고친 뒤에도 이전 조건만 보이면 Ready 상태인지 확인하고 새 후보를 만드세요. Measurement는 준비한 당시의 Experiment 버전에 속하므로 이전 버전의 Measurement를 새 소스로 실행할 수 없습니다.

## 해결 확인

첫 오류가 사라지고 Ready가 되면 Viewer의 형상과 Vars를 다시 확인하세요. 소스를 바꾸었다면 저장한 뒤 새 Measurement로 진행합니다. 실행 단계에서 실패한다면 [Measurement 실행 또는 결과 오류](troubleshooting-runtime-results.md)를 확인하세요.
