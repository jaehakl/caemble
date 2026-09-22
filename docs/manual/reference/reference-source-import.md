# 소스 파일과 import 규칙

Experiment는 여러 소스 파일을 하나의 묶음(bundle)으로 저장합니다. 이 문서에서는 **파일을 나누어 사용하는 방법**과 **실행 기록이 있는 실험을 수정해 저장하는 방법**을 설명합니다. 파일별 역할은 [Experiment 구성 안내](../program/program-overview.md)를 참고하세요.

## 같은 소스 묶음 안에서 가져오기

핵심 파일뿐 아니라 사용자가 추가한 로컬 `.ts`, `.tsx` 파일도 함께 저장합니다. TypeScript/TSX에서는 같은 묶음 안의 다른 파일을 상대 경로로 가져올 수 있습니다. Python은 `simulate.py` 한 파일만 사용합니다. `@caemble/core` 외의 패키지, URL, 동적 `import()`와 `require()`는 지원하지 않습니다.

Experiment 정의는 `experiment({...})`, 각 Task는 `defineTask({...})`를 기본 내보내기(default export)로 제공합니다. `material.tsx`는 이름이 있는 Material 객체 또는 생성 함수를, `geometry.tsx`는 PascalCase 이름의 `Geometry<Props>` 함수 컴포넌트를 내보냅니다. 형상 컴포넌트는 여러 개를 내보낼 수 있습니다. 의존하는 코드는 같은 Experiment 묶음에 두며 별도 Geometry 저장소나 버전 주소를 해석하지 않습니다.

아래는 상대 경로 import를 보여 주는 부분 예시입니다. 완성 파일이 아니므로 실제 형상 작성에는 필요한 공개 API import와 컴포넌트 정의를 함께 사용하세요.

```tsx
// geometry.tsx
import { profilePoints } from "./lib/profile";
export const Conductor: Geometry = () => <Polygon points={profilePoints} />;
```

## 예제·저장된 실험·데모 구분하기

Experiment Manager는 소스만 있는 **Example**, 저장된 사용자 Experiment Version, 데이터가 있는 공개 **Demo**를 구분합니다. 저장된 주소는 `namespace / repository / key / SemVer`로 식별합니다. Repository는 별도로 관리하는 객체가 아니라 저장된 Experiment를 묶는 그룹입니다.

## 저장과 새 버전 만들기

**Save**의 동작은 현재 저장 상태에 따라 달라집니다.

- 아직 저장하지 않은 Draft라면 **Save As**가 열립니다.
- 저장된 버전에 Measurement가 없으면 해당 버전을 덮어씁니다.
- Measurement가 하나라도 있으면 현재 Experiment를 대상으로 **Save As**가 열립니다.

**Save As**에서 기존 대상을 선택하면 최신 버전의 patch/minor/major를 올립니다. 새 Experiment를 선택하면 새로운 repository/key에 `0.1.0` 버전을 만듭니다. 저장할 때 컴파일된 RecordedData 선언도 ExperimentRecord 규격으로 함께 반영됩니다.

Measurement가 있는 버전은 소스와 Record 규격이 잠깁니다. 따라서 key·QuantityKind·tensorOrder·dtype·데이터 형식을 바꾸려면 새 버전이나 Save As를 사용하세요. Workbench에서는 이름·설명 같은 메타데이터만 바꾸더라도 Measurement가 있으면 새 버전으로 저장합니다. 기존 CLI/API의 메타데이터 저장 규칙은 유지됩니다.

## 같은 입력으로 같은 형상 만들기

개별 형상 미리보기에서는 이름으로 내보낸 함수를 사용자 정의 속성 없이 호출할 수 있습니다. 모든 로컬 PascalCase `Geometry<Props>` 함수는 사용자 정의 속성을 직접 구조 분해하고 각각 명시적인 기본값을 제공해야 합니다. `id`, Material, 자식 요소와 변환에는 평가기가 공통 기본값을 넣습니다.

소스를 컴파일한 뒤에는 지정된 Candidate 변수로 같은 컴파일 결과를 다시 평가합니다. 브라우저나 Node 전역, 시간, 네트워크 같은 외부 상태에 의존하면 같은 Measurement 입력을 재현할 수 없습니다.

## Calculation이 함께 저장되는 방식

카탈로그 예제에 등록된 Calculation은 개인 Experiment로 저장할 때 함께 저장됩니다. **Save As**에서 새 Experiment를 만들면 현재 원본의 Calculation을 복사합니다. 기존 대상을 선택해 새 버전을 만들면 그 대상 버전에 있는 Calculation 전체의 이름·설명·코드를 이어받습니다.

새 Calculation에는 새 ID와 revision 1이 부여됩니다. Measurement·실행 결과·기존 검증 규격은 복사하지 않습니다. 대상 Experiment에서 Measurement를 실행하고 Calculation을 다시 검증한 뒤 저장하세요. 편집 중인 미저장 Calculation 초안은 복사 대상이 아닙니다.

Calculation만 있고 Measurement가 없으면 Experiment 소스와 Record 규격을 덮어쓸 수 있습니다. 소스나 Record 규격을 바꾸면 기존 Calculation은 다시 검증해야 하는 상태가 됩니다. 이름·설명만 수정하면 검증 상태를 유지합니다. 실행 전이라도 저장된 Measurement가 하나 있으면 소스와 Record 규격은 잠깁니다.

파일을 고친 뒤 무엇이 다시 준비되는지는 [편집과 실행 결과의 관계](../workbench/workbench-authoring-cycle.md), 결과 계산을 이어서 작성하는 방법은 [Calculation 안내](../workbench/workbench-calculation.md)를 참고하세요.
