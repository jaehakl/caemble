# experiment.tsx: 변수와 저장할 결과 정하기

`experiment.tsx`는 실험 전체가 공유하는 입력과 저장할 결과를 정하는 파일입니다. 이 문서에서는 **어떤 변수를 바꿀 수 있는지**, **실행 후 어떤 수치 결과를 남길지**를 살펴봅니다. 처음이라면 [파일 구성 안내](program-overview.md)와 공식 예제를 함께 열어 두세요.

## 저장할 결과 연결하기

`experiment({...})`의 `recordedData`는 `결과이름: { task, output }` 형태로 선언합니다. `task`는 Task 파일의 이름, `output`은 그 Task에서 요청한 Box Grid 출력의 `key`입니다. 출력 대상(target)은 Experiment 또는 해당 Task의 Box 하나이며, 기록할 격자 크기인 `gridShape`를 반드시 지정합니다.

빌드 과정에서 카탈로그에 정의된 7차원 데이터 형식과 시각화 의미를 가져와 결과 규칙을 고정합니다. 텐서나 그룹 형식을 직접 작성하지 않습니다. 메쉬와 광선 경로는 별도 자동 시각화로 제공되므로 `recordedData`에 선언하지 않습니다.

실행이 성공하려면 선언한 결과 이름마다 정확히 한 번 기록해야 합니다. `sim.record`에는 선언한 Task와 출력에서 생성되었고 아직 해제하지 않은 데이터 참조(artifact)를 전달하세요. 선언하지 않은 결과, 중복·누락 기록, 다른 출처의 데이터는 오류가 됩니다. 자세한 내용은 [결과 기록과 Viewer](program-domain-recording.md)를 참고하세요.

## 변수 범위와 모양 지정하기

`varsSchema`의 각 항목에는 `min`, `max`와 필요한 경우 `shape`를 작성합니다. 숫자 하나인 스칼라는 `shape`를 생략할 수 있으며 기본값은 `[]`입니다. 명시적인 `shape: []`도 유효합니다. 배열 형태인 텐서는 `[3]`, `[13, 4]`처럼 차원을 반드시 지정하며, 최대 2차원까지만 허용합니다. 3차원 이상은 작성 시 타입 검사와 실행 시 Experiment 생성 단계에서 오류가 됩니다. 각 차원은 JavaScript가 안전하게 표현할 수 있는 양의 정수여야 합니다. 이 차원 제한은 `varsSchema`에만 적용하며 Geometry 배열과 Solver·RecordedData 텐서에는 적용하지 않습니다.

`min`과 `max`는 모든 원소에 공통으로 적용되는 유한한 숫자이고 `min <= max`여야 합니다. 전체 원소 수는 65,536개 이하여야 합니다. 입력값을 보고 모양을 추정하거나 스칼라를 텐서로 자동 확장하지 않습니다. 다음은 `varsSchema` 내부만 보여 주는 부분 예시입니다.

```tsx
varsSchema: {
  radius: { min: 2, max: 5 },
  position: { shape: [3], min: -10, max: 10 },
}
```

이 예시에서 `radius`는 숫자 하나이고, `position`은 숫자 3개로 이루어진 배열입니다. Candidate에 넣는 값은 선언한 모양과 정확히 같아야 하며, 빠진 원소나 길이가 서로 다른 중첩 배열을 사용할 수 없습니다. 축별 범위가 다르면 `positionX`, `positionY`, `positionZ`처럼 스칼라 변수로 나누고 형상을 만드는 함수에서 조합하세요.

## 형상과 대상 그룹 확인하기

형상을 만드는 `geometry` 콜백은 `({ vars })`로 값을 받습니다. 같은 입력으로 같은 형상을 만들 수 있도록 외부의 변경 가능한 상태에 의존하지 않아야 합니다. 같은 부모 아래의 컴포넌트 `id`는 고유해야 하며, 이 ID를 `geometryGroup`에 넣어 `experiment.geometry.<group>`으로 참조합니다.

CAD API v1의 표면은 `<geometry-id>/surface/<non-negative-index>` 형식으로 지정합니다. [형상 카탈로그](/doc?help=geometry)에 표시된 요소별 고정 표면 번호를 사용하고, Viewer에서 실제 대상을 확인하세요.

[전기·열 복합해석 예제의 experiment.tsx 열기](/doc?help=examples&item=caemble:experiment/caemble/verified/electro-thermal-notched-bar@6.0.2)에서 변수와 결과 연결을 함께 확인할 수 있습니다. 이어서 [재료 연결](program-materials.md)과 [Task 작성](program-task.md)을 읽어 보세요.
