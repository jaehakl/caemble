# unit, QuantityKind 또는 Material 오류

## 증상과 확인 위치

오류에 표시된 모델 ID와 파라미터 경로를 기준으로 **Material Model**에서 입력 규격을 확인하세요. 물리량 이름을 누르면 **QuantityKind**의 허용 단위와 사용 관계로 이동할 수 있습니다.

## 해결 순서

1. Model Catalog에서 정확한 `model` ID와 버전을 확인합니다. Material 이름은 외부 조회 키가 아닙니다.
2. 오류가 표시한 `models.<instance>.parameters` 경로에서 필수 값·객체·리스트 항을 확인합니다.
3. 해당 Model Parameter의 QuantityKind, shape와 단위를 확인합니다. Quantity Catalog의 `applicableUnits`와 실제 worker 변환 계약을 모두 만족해야 합니다.
4. Solver가 그 Material 역할에 요구하는 모델 그룹을 확인합니다. 호환 인스턴스가 여러 개이면 Task의 `materialModels`에서 하나를 지정합니다.
5. 수치 tensor의 shape·dtype·basis를 확인하고, Vars를 변경했다면 새 Candidate의 Material 입력이 다시 생성됐는지 확인합니다.

## 해결 확인

등록되지 않은 모델이나 불완전한 파라미터는 실행을 차단합니다. Material 이름, source/version, 예전 DB 값으로 누락된 계수를 보충하지 않습니다. 계수를 직접 입력하고 다시 빌드하세요.

`invalid_unit`은 worker가 해당 QuantityKind에 대해 변환할 수 없는 단위라는 뜻입니다. catalog membership 하나만 보고 새 단위를 추가하지 마세요.
