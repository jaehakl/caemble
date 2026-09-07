# 편집, Candidate 생성과 실행 결과의 관계

Source를 수정하면 `Dirty → Checking → Compiling → Evaluating → Resolving Materials → Ready` 순서로 검증됩니다. `Error`가 보이면 가장 먼저 diagnostics의 파일명과 line을 확인합니다.

- **Source 수정**은 새 revision을 compile합니다.
- **Generate Candidate**는 source를 바꾸지 않고 완전한 새 vars를 생성해 preview합니다.
- Calculation의 **Vars** 패널에서는 현재 Candidate의 `varsSchema` key를 선택해 scalar·1-D 막대 또는 2-D/N-D heatmap으로 값을 직접 편집할 수 있습니다. 편집값은 Viewer에 다시 평가되며 schema의 min/max를 벗어날 수 없습니다.
- Candidate는 저장 전까지 임시 상태이며 provenance나 seed 계약이 아닙니다.
- **Save Current Measurement**는 현재 vars와 Material snapshot을 고정하지만 solver를 실행하지 않습니다.
- **Save & Run**은 화면의 현재 수동 Candidate를 새 Prepared Measurement로 저장한 뒤 그대로 실행합니다. **Generate & Run**과 달리 새 무작위 Candidate를 만들지 않습니다.
- 선택한 prepared Measurement만 실행할 수 있고, Recorded 상태가 된 Measurement는 다시 실행할 수 없습니다.

새 조건으로 다시 계산하려면 기존 Measurement를 덮어쓰지 말고 새 Candidate를 생성한 뒤 새 Measurement로 저장하세요.
