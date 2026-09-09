# Admin: 공개 Demo 큐레이션

**Admin** 메뉴는 admin 역할에만 표시되며 **Users**, **All Experiments**, **Demo Curation** 화면을 제공합니다. 모델 정의는 **Model Catalog**에서 조회하며, 재료별 계수를 저장하는 관리 화면은 제공하지 않습니다.

Demo Curation에는 admin 사용자가 소유한 정확한 Experiment Version만 등록할 수 있습니다. 완전한 Recorded Measurement와 그 Measurement를 사용하는 ready Calculation 및 CalculationData가 하나 이상 있어야 **Ready**가 됩니다. 순서를 바꾸고 대표 Demo를 별표로 지정한 뒤 저장하세요. 대표 Demo를 해제하거나 삭제하면 다음 순서의 정상 Demo가 대표가 됩니다.

Admin은 Demo의 Experiment source, Measurement, RecordedData, Calculation과 CalculationData를 Workbench에서 관리할 수 있습니다. Measurement가 있는 기존 Experiment Version의 source는 잠겨 있으므로 덮어쓰지 말고 **New Version**으로 저장해야 합니다. 새 Version은 자동으로 Demo가 되지 않으며 Demo Curation에서 명시적으로 교체해야 합니다. Measurement나 Calculation을 삭제해 준비 조건이 깨져도 Demo는 자동 공개 해제되지 않고 **Not Ready**로 표시됩니다.

**주의:** Demo 등록은 스냅샷을 만들지 않습니다. 해당 Version의 source bundle과 현재 및 향후 생성되는 전체 ExperimentRecord, Measurement, RecordedData, Calculation, CalculationData가 즉시 공개되고 복사 가능한 정보로 간주됩니다. 민감하거나 앞으로 공개되어서는 안 되는 데이터를 가진 Experiment는 등록하지 마세요. 공개 해제를 저장하면 익명 접근은 즉시 철회됩니다.
