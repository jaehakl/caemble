# unit, QuantityKind 또는 Material 오류

1. Material key를 Material Catalog에서 정확히 복사합니다.
2. 그 key가 가리키는 QuantityKind를 확인합니다.
3. Quantity Catalog에서 현재 unit이 `applicableUnits`에 있는지 확인합니다.
4. solver parameter가 요구하는 QuantityKind와 dtype을 Physics Catalog에서 확인합니다.
5. vector/matrix 값의 shape와 basis 조건을 확인합니다.

`invalid_unit`은 이름이 그럴듯한 단위라도 worker가 해당 QuantityKind에 대해 변환할 수 없다는 뜻입니다. catalog membership 하나만 보고 새 단위를 추가하지 마세요.
