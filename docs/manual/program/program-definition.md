# experiment.tsx: 변수와 RecordedData 계약

`experiment({...})`의 `recordedData`는 `결과이름: { task, output }`으로 선언합니다. `output`은 해당 Task가 요청한 Box Grid output의 `key`입니다. target은 Experiment 또는 해당 Task의 Box 하나이며 `gridShape`를 필수로 지정합니다. 공통 빌드가 Catalog 계약에서 7차원 데이터 schema와 시각화 의미를 가져와 고정합니다. 메쉬·ray path는 별도 자동 시각화로 포함되며 `recordedData`에 선언하지 않습니다. 수동 tensor/group schema는 허용하지 않습니다.

성공 실행에서는 모든 declared key가 정확히 한 번 기록되어야 합니다. `sim.record`에는 선언한 Task/output의 live artifact를 전달합니다. undeclared, duplicate, missing record와 출처가 다른 artifact는 실행 오류입니다. 자세한 저장·조회·Viewer 규칙은 [RecordedData 계약](program-domain-recording.md)을 참고하세요.

`varsSchema`의 각 항목은 `min`, `max`와 선택적인 `shape`를 사용합니다. scalar는 `shape`를 생략할 수 있으며 기본값은 `[]`입니다. 명시적인 `shape: []`도 유효합니다. tensor는 `[3]`, `[4, 4, 1]`처럼 양의 safe integer 차원을 반드시 명시합니다. `min`과 `max`는 tensor가 아니라 모든 원소에 공통 적용되는 finite scalar이고 `min <= max`여야 합니다. shape 전체 원소 수는 65,536개 이하여야 하며 tensor shape 추론과 scalar/tensor broadcast는 지원하지 않습니다.

```tsx
varsSchema: {
  radius: { min: 2, max: 5 },
  position: { shape: [3], min: -10, max: 10 },
}
```

Candidate는 선언한 shape와 정확히 같은 dense rectangular numeric tensor여야 합니다. 축별 범위가 다르면 `positionX`, `positionY`, `positionZ`처럼 의미별 scalar 변수로 분리한 뒤 Geometry callback에서 다시 조합하세요. Geometry callback은 `({ vars })`로 값을 받고 외부의 변경 가능한 상태에 의존하지 않아야 합니다. 같은 parent 아래의 component `id`는 고유해야 하며, 이 ID를 `geometryGroup`에 넣어 `experiment.geometry.<group>`으로 참조합니다. CAD API v1의 surface member는 `<geometry-id>/surface/<non-negative-index>` 형식이며 Geometry Catalog에 표시된 primitive별 고정 slot을 사용합니다.

[Electro-Thermal Notched Bar의 canonical experiment.tsx 열기](/?help=examples&item=caemble:experiment/caemble/verified/electro-thermal-notched-bar@5.0.0)
