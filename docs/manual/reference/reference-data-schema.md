# DataSchema, QuantityKind와 UCUM 단위

물리 데이터는 값만 전달하지 않습니다. `dtype`, `unit`, `quantityKind`, 필요하면 `axes`가 함께 계약을 이룹니다.

아래의 scalar/component 규칙은 Material 모델 파라미터 등 일반 DataSchema에 적용합니다.

- scalar는 axes가 없습니다.
- vector 또는 matrix의 component shape는 QuantityKind의 `tensorOrder`와 일치해야 합니다.
- 공간장과 time-series의 sample 축은 `axes`에서 길이와 의미를 선언합니다.
- unit은 [Quantity Catalog](/doc?help=quantity-kinds)의 `applicableUnits`에 있고 worker가 변환할 수 있는 UCUM 문자열이어야 합니다.
- `{fraction}`처럼 중괄호가 있는 UCUM annotation도 문자열 그대로 사용합니다.

Model Catalog의 각 파라미터가 요구하는 QuantityKind·shape·unit과 실제 worker의 단위 변환 계약을 모두 만족해야 합니다.

RecordedData의 Box Grid Output은 별도 계약입니다. scalar도 `[x, y, z, time, frequency, amplitudePhase, component]` 일곱 축을 유지하고, 모든 성분을 마지막 축에 평탄화합니다. `tensorOrder`만큼 추가 차원을 붙이지 않습니다. 복소수도 float32/float64의 진폭·위상 채널로 저장하며, 자세한 계약은 [출력과 기록](../program/program-domain-recording.md)을 참고하세요.
