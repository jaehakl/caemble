# 관리자를 위한 공개 Demo 설정

공개 Demo는 로그인하지 않은 사용자도 형상과 결과를 둘러보고 예측을 체험할 수 있는 Experiment입니다. 이 문서는 관리자(admin)가 Demo의 공개 여부와 순서를 관리하는 방법을 안내합니다.

## Demo 등록과 순서 설정

**Admin** 메뉴는 관리자에게만 표시되며 **Users**, **All Experiments**, **Demo Curation** 화면을 제공합니다. **Demo Curation**에는 관리자 본인이 소유한 특정 Experiment 버전을 등록할 수 있습니다.

1. 공개할 Experiment 버전과 데이터를 확인합니다.
2. Demo Curation에 해당 버전을 등록하고 표시 순서를 정합니다.
3. 처음 보여 줄 대표 Demo를 별표로 지정한 뒤 저장합니다.

대표 Demo를 해제하거나 삭제하면 다음 순서의 Demo가 대표가 됩니다. Prediction 데이터가 아직 없어도 Demo와 대표 Demo로 지정할 수 있습니다.

## Ready와 Not Ready의 의미

**Ready**는 완전한 Recorded Measurement와 이를 사용하는 준비된 Calculation·CalculationData가 있어 Prediction을 사용할 수 있다는 뜻입니다. **Not Ready**는 이 준비가 부족한 상태입니다. 이 표시는 예측 준비 여부를 알려 주며 Demo 등록 자체의 조건은 아닙니다.

Measurement나 Calculation을 삭제해 준비 조건이 깨져도 자동으로 공개를 해제하지 않습니다. Demo는 계속 공개되고 Not Ready로 표시됩니다.

## 공개 데이터와 버전 관리

> **Demo는 한 시점의 복사본이 아닙니다.** 등록한 버전의 소스 묶음과 현재 및 이후에 생성되는 모든 ExperimentRecord, Measurement, RecordedData, Calculation, CalculationData가 즉시 공개됩니다. 사용자가 복사할 수 있는 정보이므로 공개할 수 있는 데이터만 포함하세요.

관리자는 Workbench에서 Demo의 소스와 연결된 데이터를 관리할 수 있습니다. Measurement가 있는 버전의 소스는 잠겨 있으므로 수정한 소스는 새 버전으로 저장합니다. 새 버전은 자동으로 Demo가 되지 않으므로 Demo Curation에서 공개 대상을 직접 교체하세요. 공개 해제를 저장하면 익명 사용자의 접근은 즉시 철회됩니다.

재료 모델의 정의는 **Model Catalog**에서 조회합니다. 재료별 계수를 별도로 저장하는 관리자 화면은 제공하지 않습니다.
