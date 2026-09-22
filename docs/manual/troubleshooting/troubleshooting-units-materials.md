# 단위와 물리량, Material 오류 해결하기

재료 입력은 숫자값만 맞는다고 준비가 끝나지 않습니다. 어떤 물리량인지(QuantityKind), 어떤 단위인지(unit), 값이 어떤 모양인지(shape)도 모델이 요구하는 규격과 맞아야 합니다.

## 증상과 확인 위치

오류 메시지의 모델 ID와 파라미터 경로를 찾아 [Material Model](/doc?help=materials)의 입력 규격과 비교하세요. 물리량 이름을 누르면 QuantityKind에서 허용 단위와 사용 관계를 확인할 수 있습니다.

## 해결 순서

1. 카탈로그에서 정확한 `model` ID와 버전을 확인합니다. Material의 이름을 썼다고 외부에서 계수를 자동으로 가져오지는 않습니다.
2. 오류가 가리키는 `models.<instance>.parameters`에서 필수 값과 객체·리스트 항목이 빠지지 않았는지 확인합니다.
3. 파라미터의 QuantityKind, 배열 크기(shape)와 단위를 비교합니다. [QuantityKind 카탈로그](/doc?help=quantity-kinds)의 `applicableUnits`에 포함되고 worker에서도 변환할 수 있는 단위여야 합니다.
4. Solver가 해당 재료 역할에 요구하는 모델 그룹을 확인합니다. 사용할 수 있는 모델 인스턴스가 여러 개라면 Task의 `materialModels`에서 하나를 지정합니다.
5. 텐서의 shape·자료형(dtype)·성분 기준(basis)을 확인합니다. Vars를 바꾸었다면 새 후보의 재료 입력도 다시 만들어졌는지 확인하세요.

## 해결 확인

누락된 계수를 직접 입력하고 다시 빌드합니다. 등록되지 않은 모델이나 불완전한 파라미터가 남아 있으면 실행할 수 없습니다. Material 이름, 소스 버전, 예전 데이터베이스의 값으로 누락된 계수를 자동 보충하지 않습니다.

`invalid_unit`은 worker가 해당 물리량의 단위를 변환할 수 없다는 뜻입니다. 카탈로그에 문자열이 있다는 사실만으로 변환 가능하다고 판단하지 마세요. 자세한 의미는 [DataSchema와 단위](../reference/reference-data-schema.md)에서 확인할 수 있습니다.
