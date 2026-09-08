# 문서가 Ready가 되지 않을 때

## 증상과 확인 위치

Source를 수정한 뒤 `Ready`가 되지 않거나 실행 버튼이 비활성화되면 **Experiment → Source의 diagnostics**에서 첫 오류를 확인하세요. 뒤따르는 오류는 첫 오류가 해결되면 사라질 수 있습니다.

| 증상                     | 비교할 정보                   | 해결 방법                                             |
| ------------------------ | ----------------------------- | ----------------------------------------------------- |
| import·export·TSX 오류   | 표시된 파일명과 줄 번호       | 현재 API Reference와 Geometry 문법에 맞춰 수정합니다. |
| Vars·shape 오류          | `varsSchema`와 실제 Candidate | scalar와 tensor 선언, 값의 shape를 일치시킵니다.      |
| Material validation 오류 | Material Model의 필수 값·단위 | 해당 모델의 입력 규격을 확인하고 빠진 값을 채웁니다.  |
| Surface·ID 오류          | Geometry의 ID와 Surface 슬롯  | 중복 ID와 범위를 벗어난 Surface 참조를 수정합니다.    |

## 해결 순서

1. diagnostics에 표시된 **파일명, line, column과 첫 오류**부터 확인합니다.
2. import가 `@caemble/core`인지, 올바른 default export를 사용하는지 확인합니다.
3. TSX tag와 prop 이름을 Geometry Catalog의 syntax와 비교합니다.
4. `varsSchema`의 scalar min/max, tensor의 필수 shape, Candidate의 정확한 shape, Geometry ID 중복과 group member ID를 확인합니다.
5. surface group이 `<geometry-id>/surface/<non-negative-index>`를 사용하고 Geometry Catalog의 primitive별 고정 slot 범위에 있는지 확인합니다.
6. 모델 ID와 필수 파라미터, dtype, unit과 tensor shape를 Model Catalog와 비교합니다.

source를 고친 뒤에도 이전 조건만 보인다면 상태가 `Ready`인지 확인하고 새 Candidate를 생성합니다. 이전 Experiment revision의 Measurement는 현재 revision에서 실행할 수 없습니다.

## 해결 확인

첫 오류가 사라지고 `Ready`가 되면 Viewer의 형상과 Vars를 다시 확인하세요. 실행 단계에서 실패한다면 [Measurement 실행 또는 결과 오류](troubleshooting-runtime-results.md)로 이동하세요.
