# 데이터의 모양과 단위 이해하기

물리 데이터는 숫자만으로 의미가 정해지지 않습니다. 같은 숫자라도 길이인지 온도인지, 단위가 무엇인지에 따라 해석이 달라집니다. DataSchema는 **값의 자료형, 물리적 의미, 단위와 배열의 모양**을 함께 설명하는 규칙입니다.

## 먼저 알아둘 항목

| 항목 | 의미 |
| --- | --- |
| `dtype` | 값을 저장하는 자료형 |
| `quantityKind` | 길이·온도처럼 값이 나타내는 물리량의 종류 |
| `unit` | UCUM 표기법으로 작성한 단위 |
| `axes` | 필요한 경우 배열 각 축의 길이와 의미 |

QuantityKind의 정확한 이름과 허용 단위는 [물리량·단위 카탈로그](/doc?help=quantity-kinds)에서 찾을 수 있습니다. 재료를 입력하는 중이라면 [재료 모델 카탈로그](/doc?help=materials)에서 해당 파라미터가 요구하는 형식을 함께 확인하세요.

## 일반 데이터의 모양 확인하기

아래 규칙은 재료 모델 파라미터 등 일반 DataSchema에 적용합니다.

- 숫자 하나인 스칼라는 `axes`가 없습니다.
- 벡터나 행렬의 성분 모양은 QuantityKind의 `tensorOrder`와 일치해야 합니다.
- 공간 분포나 시간 이력의 표본 축은 `axes`에서 길이와 의미를 선언합니다.
- 단위는 카탈로그의 `applicableUnits`에 있으며 실행 환경에서 변환할 수 있는 UCUM 문자열이어야 합니다.
- `{fraction}`처럼 중괄호가 있는 UCUM 주석도 문자열 그대로 사용합니다.

단위가 그럴듯해 보이는 것만으로는 충분하지 않습니다. 모델의 QuantityKind·배열 모양·단위 규격과 실제 실행 환경의 단위 변환 규칙을 모두 만족해야 합니다.

## Box Grid 결과는 일곱 축으로 읽기

RecordedData의 Box Grid 출력에는 별도 규칙이 적용됩니다. 스칼라 값도 `[x, y, z, time, frequency, amplitudePhase, component]` 일곱 축을 유지하고, 모든 성분을 마지막 축에 펼쳐 저장합니다. `tensorOrder`만큼 차원을 추가하지 않습니다. 복소수 역시 float32/float64의 진폭·위상 채널로 저장합니다.

재료 입력과 결과 데이터의 모양을 혼동하지 않도록, 기록한 결과를 처리할 때는 그 결과의 저장 규격을 확인하세요. 자세한 내용은 [결과 기록과 Viewer](../program/program-domain-recording.md), 오류 점검 순서는 [단위·재료 문제 해결](../troubleshooting/troubleshooting-units-materials.md)을 참고하세요.
