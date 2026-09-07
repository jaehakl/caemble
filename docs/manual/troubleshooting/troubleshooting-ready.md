# 문서가 Ready가 되지 않을 때

1. diagnostics에 표시된 **파일명, line, column과 첫 오류**부터 확인합니다.
2. import가 `@caemble/core`인지, 올바른 default export를 사용하는지 확인합니다.
3. TSX tag와 prop 이름을 Geometry Catalog의 syntax와 비교합니다.
4. `varsSchema`의 scalar min/max, tensor의 필수 shape, Candidate의 정확한 shape, Geometry ID 중복과 group member ID를 확인합니다.
5. surface group이 `<geometry-id>/surface/<non-negative-index>`를 사용하고 Geometry Catalog의 primitive별 고정 slot 범위에 있는지 확인합니다.
6. Material key, dtype, unit과 tensor shape를 catalog와 비교합니다.

source를 고친 뒤에도 이전 조건만 보인다면 상태가 `Ready`인지 확인하고 새 Candidate를 생성합니다. 이전 Experiment revision의 Measurement는 현재 revision에서 실행할 수 없습니다.
