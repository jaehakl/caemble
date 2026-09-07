# DataSchema, QuantityKind와 UCUM 단위

물리 데이터는 값만 전달하지 않습니다. `dtype`, `unit`, `quantityKind`, 필요하면 `axes`가 함께 계약을 이룹니다.

- scalar는 axes가 없습니다.
- vector 또는 matrix의 component shape는 QuantityKind의 `tensorOrder`와 일치해야 합니다.
- 공간장과 time-series의 sample 축은 `axes`에서 길이와 의미를 선언합니다.
- unit은 [Quantity Catalog](/docs?section=quantity-kinds)의 `applicableUnits`에 있고 worker가 변환할 수 있는 UCUM 문자열이어야 합니다.
- `{fraction}`처럼 중괄호가 있는 UCUM annotation도 문자열 그대로 사용합니다.

Material catalog에 key가 존재한다는 사실만으로 임의 unit이 허용되는 것은 아닙니다. Material의 QuantityKind와 실제 worker unit converter 계약을 모두 만족해야 합니다.
