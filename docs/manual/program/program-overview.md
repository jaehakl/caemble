# Experiment 파일 구성 이해하기

Experiment는 형상, 재료, 해석 조건과 실행 순서를 함께 담은 실험입니다. 여러 파일로 나뉘어 있지만, 처음부터 모두 작성할 필요는 없습니다. [공식 예제](/doc?help=examples)를 열고 **어떤 내용을 어느 파일에서 바꾸는지**부터 익혀 보세요.

화면에서 예제를 여는 방법이 궁금하다면 [빠른 시작](../workbench/workbench-quickstart.md)을 먼저 읽어 주세요. 이 문서에서는 예제의 파일 구성을 이해하고, 원하는 조건을 바꿀 위치를 찾습니다.

## 파일별로 무엇을 작성하나요

| 파일 | 작성할 내용 |
| --- | --- |
| `experiment.tsx` | 공통 길이 단위, 변수 범위, 형상·재료 연결, 대상 그룹, 최종 저장 결과 |
| `geometry.tsx` | Experiment와 Task에서 재사용할 형상 컴포넌트 |
| `material.tsx` | 이름이 있는 Material 객체 또는 변수에 따라 Material을 만드는 함수 |
| `tasks/<name>.tsx` | 사용할 Solver와 버전, 필요할 경우 Task 전용 형상, `config({ vars })` 해석 설정 |
| `simulate.py` | Task 실행 순서, 조건 분기, 중간 데이터 전달·해제, 결과 기록 |
| 그 밖의 `.ts`, `.tsx` 파일 | 같은 소스 묶음 안에서 상대 경로로 불러오는 보조 코드 |

공통 형상과 Task 보조 형상은 `geometry.tsx`, Material 정의는 `material.tsx`에서 이름을 붙여 내보내고(named export), `experiment.tsx`와 각 Task에서 상대 경로로 가져옵니다. 필요한 보조 코드는 같은 소스 묶음(bundle)에 파일을 추가해 사용할 수 있습니다. 소스 묶음 밖의 패키지, URL, 동적 `import()`와 `require()`는 지원하지 않습니다.

`experiment.tsx`의 `lengthUnit`, `varsSchema`, `geometry({ vars })`, `geometryGroup`, `surfaceGroup`, `recordedData`는 여러 Task가 공유할 형상·입력과 최종 결과의 규칙을 정합니다. 숫자만 보고 SI 단위라고 가정하지 말고, 형상의 길이 단위와 각 DataSchema의 UCUM 단위를 함께 확인하세요.

## 예제를 읽는 순서

1. `experiment.tsx`에서 바꿀 수 있는 변수와 저장할 결과를 확인합니다.
2. `geometry.tsx`에서 형상이 어떻게 만들어지는지 보고, `material.tsx`에서 사용할 물리 모델과 계수를 확인합니다.
3. `tasks/*.tsx`에서 어떤 Solver가 어느 형상·표면을 계산하는지 확인합니다.
4. `simulate.py`에서 Task 실행 순서와 결과를 기록하는 위치를 따라갑니다.

형상을 바꾸는 일과 결과를 저장하는 일을 구분할 수 있다면 첫 단계는 충분합니다. 다음으로 [변수와 저장 결과 선언](program-definition.md)을 읽고, 형상 작성이 필요할 때 [Geometry 기본 구조](../reference/reference-geometry-skeleton.md)를 참고하세요.
