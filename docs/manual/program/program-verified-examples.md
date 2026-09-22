# 공식 예제로 익히는 Experiment

처음부터 모든 파일을 작성하기 어렵다면 공식 예제로 시작해 보세요. Workbench와 UI-CAE 계약 테스트는 카탈로그의 같은 소스 묶음을 사용합니다. 이 문서는 배우고 싶은 내용에 맞는 예제를 찾고, 소스를 읽는 순서를 안내합니다.

## 어떤 예제를 고르면 좋을까요

형상과 재료 연결이 궁금하다면 **Two-material Wheel Assembly**, 여러 Solver의 연결이 궁금하다면 **Electro-Thermal Notched Bar**부터 살펴보세요. 광학 예제는 광원·검출기 배치를 이해한 뒤 [광선 추적 안내](program-ray-tracing.md)와 함께 읽으면 좋습니다. 아래 링크에서 실제 소스와 현재 연결된 Solver를 확인할 수 있습니다.

- [Transmission Imaging Spectrometer](/doc?help=examples&item=caemble:experiment/caemble/verified/transmission-imaging-spectrometer@1.0.0): 구매 부품 외형과 미확정 치수 Vars, 3렌즈 등가 광학계, 공간 위치별 픽셀 응답. 스캔은 포함하지 않습니다.

- [Electro-Thermal Notched Bar](/doc?help=examples&item=caemble:experiment/caemble/verified/electro-thermal-notched-bar@6.0.2): 전기 해석의 발열을 열 해석으로 전달하는 흐름을 익힙니다. [단계별 해설](program-multiphysics-example.md)을 함께 읽어 보세요.
- [Folded Ray-Tracing Bench](/doc?help=examples&item=caemble:experiment/caemble/verified/folded-ray-tracing@7.0.4)
- [FDTD Drude Slab Pulse](/doc?help=examples&item=caemble:experiment/caemble/verified/fdtd-drude-slab@6.0.0)
- [Fiber Bundle](/doc?help=examples&item=caemble:experiment/caemble/advanced-shapes/fiber-bundle@7.0.0)
- [Layered Solid Cutaways](/doc?help=examples&item=caemble:experiment/caemble/advanced-shapes/layered-cutaways@6.0.0)
- [Random Curved-edge Cylinder Array](/doc?help=examples&item=caemble:experiment/caemble/arrays/random-curved-edge-cylinder-array@5.0.0)
- [Random Sphere HCP Array](/doc?help=examples&item=caemble:experiment/caemble/arrays/random-sphere-hcp-array@6.0.0)
- [Two-material Wheel Assembly](/doc?help=examples&item=caemble:experiment/caemble/assemblies/two-material-wheel-assembly@5.0.0)

## 예제를 내 실험으로 바꾸는 순서

1. 먼저 `experiment.tsx`의 변수와 결과 선언을 읽고, Geometry에서 무엇이 보이는지 확인합니다.
2. [파일 구성 안내](program-overview.md)를 따라 재료, Task, 실행 순서를 살펴봅니다.
3. 바꾸려는 조건을 하나 정하고, 그 조건이 변수·형상·재료·Task 중 어디에 속하는지 확인합니다.
4. 저장·실행 절차는 [빠른 시작](../workbench/workbench-quickstart.md)을 따르고, 실행 후에는 선택한 입력과 기록된 결과를 함께 확인합니다.

예제가 검증되어 있다는 것은 연결된 소스와 실행 규칙을 확인할 수 있다는 뜻입니다. 형상·재료·조건을 바꾼 뒤에도 원하는 문제를 표현하는지는 직접 점검해야 합니다. 실행 가능한 코드를 문서에서 조합하기보다 카탈로그의 전체 소스 묶음을 출발점으로 사용하세요.
