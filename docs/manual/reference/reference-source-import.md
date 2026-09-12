# 공개 Source와 import 경계

Experiment source bundle은 핵심 파일뿐 아니라 사용자가 추가한 로컬 `.ts`, `.tsx` 파일도 함께 저장합니다. TypeScript/TSX 파일은 bundle 안의 다른 파일을 상대 경로로 import할 수 있습니다. Python은 핵심 `simulate.py` 한 파일만 사용합니다. `@caemble/core` 외 package, URL, 동적 `import()`와 `require()`는 지원하지 않습니다.

Experiment 정의는 `experiment({...})`, 각 Task는 `defineTask({...})`를 default export합니다. `material.tsx`는 named Material 객체 또는 factory를 export하고, `geometry.tsx`는 PascalCase named `Geometry<Props>` 함수 component를 여러 개 export할 수 있습니다. 모든 의존 코드는 같은 Experiment bundle 안에 있으므로 별도 Geometry Repository나 Version coordinate를 해석하지 않습니다.

부분 예시 — 다음 fence는 완성 파일이 아니라 로컬 bundle import 경계만 보여줍니다.

```tsx
// geometry.tsx
import { profilePoints } from "./lib/profile";
export const Conductor: Geometry = () => <Polygon points={profilePoints} />;
```

Experiment Manager는 source-only **Example**, 저장된 사용자 Experiment Version, 데이터가 있는 공개 **Demo**를 구분해 엽니다. 저장된 coordinate는 `namespace / repository / key / SemVer`로 식별하며, Repository는 별도 관리 객체가 아니라 저장된 Experiment에서 파생되는 그룹입니다.

**Save**는 Draft이면 Save As를 열고, 저장된 Version에 Measurement가 없으면 덮어씁니다. Measurement가 하나라도 있으면 현재 Experiment를 대상으로 Save As를 엽니다. **Save As**에서 기존 대상을 선택하면 최신 버전에서 patch/minor/major를 증가시키고, 새 Experiment를 선택하면 새 repository/key의 `0.1.0`을 만듭니다. 저장 과정에서 컴파일된 RecordedData 선언은 ExperimentRecord 계약으로 함께 동기화됩니다. Measurement가 있는 Version은 source와 Record 계약이 잠기므로 key·QuantityKind·tensorOrder·dtype·data schema를 바꾸려면 새 Version 또는 Save As를 사용해야 합니다. Workbench에서는 metadata만 바꾸더라도 Measurement가 있으면 새 Version으로 저장합니다. 기존 CLI/API의 metadata 저장 계약은 유지됩니다.

Standalone preview는 선택한 named export를 props 없이 호출할 수 있습니다. 모든 local PascalCase `Geometry<Props>` 함수는 custom prop을 직접 구조 분해하고 각각 명시적인 기본값을 제공해야 합니다. `id`, Material, children과 transform은 evaluator가 공통 기본값을 주입합니다.

Source revision은 compile한 뒤 명시적인 Candidate vars로 같은 compiled source를 다시 evaluate합니다. 브라우저나 Node 전역, 시간, 네트워크 같은 외부 상태에 의존하는 코드는 재현 가능한 Measurement를 만들 수 없습니다.

카탈로그 예제에 등록된 Calculation은 개인 Experiment로 저장할 때 함께 저장됩니다. **Save As**에서 새 Experiment를 만들면 현재 원본의 Calculation을 복사하고, 기존 대상을 선택하여 새 버전을 만들면 그 대상 Version의 Calculation 전체 이름·설명·코드를 계승합니다. 새 Calculation은 새 ID와 revision 1을 가지며, Measurement·실행 결과·기존 검증 계약은 복사하지 않습니다. 대상 Experiment에서 Measurement를 실행하고 Calculation을 다시 검증한 뒤 저장하세요. 편집 중인 미저장 Calculation 초안은 복사 대상이 아닙니다.

Calculation만 있고 Measurement가 없으면 Experiment source와 Record 계약을 덮어쓸 수 있습니다. source 또는 Record 계약을 변경하면 기존 Calculation은 재검증 대기로 전환됩니다. 이름·설명만 수정하면 검증 상태를 유지합니다. 실행 전이라도 저장된 Measurement가 하나 있으면 source와 Record 계약은 잠깁니다.
