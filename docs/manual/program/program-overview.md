# Experiment Program의 파일과 책임

Experiment Program은 공통 정의와 solver별 task, 실행 정책을 분리합니다.

| 파일 | 책임 |
| --- | --- |
| `experiment.tsx` | 공통 lengthUnit, geometry, varsSchema, Material 역할 주입, group과 최종 recordedData 계약 |
| `geometry.tsx` | Experiment와 Task가 공유하는 named Geometry component |
| `material.tsx` | named Material 객체 또는 vars를 받는 Material factory |
| `tasks/<name>.tsx` | solver identity, 선택적 Task-local scene과 `config({ vars })` |
| `simulate.py` | named task 실행 순서, 분기, artifact 전달·해제·기록 |
| 그 밖의 `.ts`, `.tsx` 파일 | bundle 내부에서 상대 import하는 보조 모듈 |

공통 형상과 Task 보조 형상은 `geometry.tsx`, Material 정의는 `material.tsx`에서 named export하고 `experiment.tsx`와 각 Task에서 상대 import합니다. 필요한 보조 코드는 bundle에 파일을 추가해 로컬 상대 import할 수 있습니다. Source bundle 밖 package, URL, 동적 `import()`와 `require()`는 지원하지 않습니다.

`experiment.tsx`의 `lengthUnit`, `varsSchema`, `geometry({ vars })`, `geometryGroup`, `surfaceGroup`, `recordedData`가 여러 Task가 공유하는 물리 세계와 최종 결과 계약입니다. 숫자만 보고 SI라고 가정하지 말고 scene 길이 단위와 각 DataSchema의 UCUM 단위를 명시하세요.
