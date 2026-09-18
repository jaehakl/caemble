# Non-sequential Ray Tracing

Catalog의 `ray-tracing`은 미리 정한 표면 순서를 따르지 않고, 광선이 기하와 만나는 순서대로 반사·굴절·산란·흡수를 추적하는 non-sequential solver입니다. 다중 반사, stray light, 바플과 혼탁 매질을 포함한 광학계에 사용하세요.

### 연속 형상과 표시 해상도

Ray tracing은 Primitive의 연속 표면에서 교점과 외향법선을 계산합니다. Box, Sphere, Cylinder·원뿔대, Ellipsoid, Paraboloid, Hyperboloid, AsphericCylinder, Fiber, CurvedEdgeCylinder 및 이들의 Transform·Instance·Boolean 조합을 지원합니다. Viewer용 tessellation 설정을 바꿔도 같은 seed의 광원 표본, 교점, 법선과 광학 결과는 바뀌지 않습니다.

표면 그룹은 기존 숫자 surface slot을 사용합니다. Boolean 내부에 가려진 면에서는 충돌이나 방출이 발생하지 않으며 절삭면의 법선은 최종 solid 바깥을 향합니다. 표면 광원은 변환 후 실제 면적에 비례해 표본을 생성하고, 점광원은 최종 연속 형상의 bounds 중심에 놓입니다.

Fiber는 Line/Arc 경로와 물리적 호 길이의 반지름 profile을 그대로 사용합니다. 구간과 radius knot에는 가상 단면을 만들지 않습니다. knot의 법선은 오른쪽 미분을 사용하고 마지막 끝점에서는 왼쪽 미분을 사용합니다. 정확한 접선 접촉은 검출기에서 흡수하며 그 외에는 매질과 방향을 유지합니다. 모서리는 입사 방향과 법선 내적의 절댓값이 가장 큰 면을 선택하고 동률은 표면 식별자·배치 순서로 결정합니다.

CurvedEdgeCylinder는 전 영역에서 양의 반지름을 갖는 정칙 형상을 사용하세요. 내부·외부나 법선을 정의할 수 없는 특이 형상, 또는 수치적으로 해결하지 못한 교차는 형상과 구간을 포함한 오류로 종료합니다. 삼각형 계산으로 자동 전환하지 않습니다. Float64 연산과 근 찾기·광선 표본 오차는 남으며, 표시용 분할 수는 계산 정확도를 조절하는 설정이 아닙니다.

[Continuous Ray Optics 예제](/doc?help=examples&item=caemble:experiment/caemble/verified/continuous-ray-optics@1.0.2)는 비구면 렌즈, 굽은 taper Fiber와 Boolean 절삭 곡면을 함께 보여 줍니다.

### 광원과 산란

- 광원은 point, area, directional, Lambertian 형식을 지원합니다. 모든 광원의 emitter locator geometry 또는 surface는 `ray.domain` group에서 제외하고, 실제 방출 위치도 모든 collision solid 바깥에 두세요. 각 광원 initialization call은 하나의 이산 wavelength line을 나타내므로, 여러 call을 나란히 추가해 다중 파장 광원을 구성합니다.
- 편광은 광원의 4성분 Stokes vector로 주입합니다. 표면의 ABg 및 Lambertian scatter와 체적의 Henyey–Greenstein(HG) scatter를 사용하며, 산란된 광선은 depolarized 상태로 계속 추적됩니다.
- `ray.domain` collision solid는 올바르게 중첩할 수 있지만 서로 부분적으로 겹치면 안 됩니다. 매질 경계의 진입·이탈 순서가 모호한 overlap은 실행을 거부합니다.

### 표면 박막 적층

`ray-tracing 5.0.0`은 `boundaryConditions`의 `ray.thin-film-stack`을 `experiment.surface.<group>`에 적용합니다. 대상 solid의 Material에서 `optics.thin-film-stack@1` 모델을 선택하세요. `layers`는 순서 있는 목록이며 각 층은 단위를 가진 `thickness`와 `samples: [{ frequency, n, k }, …]`를 갖습니다. 표본 하나는 일정 광학 상수입니다. 모델 입력과 선택은 기존 Material snapshot 경로를 따릅니다.

층 순서는 solid 외부에서 내부 방향입니다. 내부에서 입사하면 역순으로 계산하고, 입사·출사 굴절률은 실제 경계의 medium stack에서 정합니다. 각 층은 엄격히 `0 < thickness < 50 µm`여야 합니다. `50 µm` 이상은 오류이며 별도 solid로 작성해야 합니다. Geometry scale은 명시된 박막 두께를 바꾸지 않습니다.

기존 TMM과 편광·반사·굴절·흡수 계산을 사용합니다. film mesh나 두께에 따른 출구 위치 이동은 생성하지 않습니다. 한 표면의 중복 적층과 detector·grating 충돌은 거부하며, 반사 후 표면 산란은 유지합니다. 이전 CAD Shell 입력은 새 source로 이관하고 재빌드해야 합니다.

박막과 체적에 사용할 광학 모델과 계수는 `material.tsx`에 명시합니다. Solver의 지원 모델과 입력 규격은 [Model Catalog](/doc?help=materials)에서 확인하세요. 주파수 표본 모델은 Hz로 엄격히 증가하는 표본열을 받아 광원 파장의 `frequency = c / wavelength`에서 각 성분을 선형 보간합니다. 표본 범위 밖에서는 가장 가까운 끝점 값을 사용합니다. 복소 굴절률 모델의 부호 및 감쇠 해석은 모델의 관례를 따릅니다.

### Detector와 ray path

경로는 `maxPaths`개까지 완료 경로 전체에서 재현 가능한 표본으로 보관합니다. 종료가 빠른 경로부터 채우지 않으며, detector 도달 여부·전력·길이에는 우선순위를 주지 않습니다. 같은 입력과 seed라면 직렬·병렬 실행에서 같은 경로를 표시합니다. 아주 작은 한도에서는 detector 도달 경로가 표본에 없을 수 있지만, 모든 광선의 수치 전력은 계속 누적합니다. 새 저장 방식은 재실행한 결과에 적용되며 이전에 저장한 경로는 바뀌지 않습니다.

체적 수치 output에는 Box 내부의 fluence rate와 radiant flux density가 있습니다. `ray.fluence-rate`는 방향을 합한 스칼라, `ray.radiant-flux-density`는 방향 성분을 가진 벡터를 기록하며 둘 다 Box target과 `gridShape`를 받습니다. 검출면 픽셀 전력과 입력 전력은 아래의 별도 수치 Output으로 기록합니다. 전체 흡수 검출면의 detected power는 실행 observation으로도 확인합니다. 경로는 자동 시각화로 포함되므로 outputs나 `recordedData`에 선언하지 않습니다. Task가 반복 실행되면 마지막 성공 invocation의 경로 snapshot을 표시합니다. Catalog의 polyline 계약이 경로 구성 데이터와 표시 방식을 결정합니다. 다른 Solver의 mesh field와도 같은 Viewer에서 선택하거나 Overlay할 수 있으며 Calculation·Analysis·Prediction 입력에는 포함하지 않습니다.

### 픽셀 전력과 입력 파장별 응답

**Pixel Monochromatic Response** 예제는 정지한 슬릿부터 검출면까지의 기하광학 응답을 보여 줍니다. 현재 Output 선언·Geometry·Calculation 원본은 [Catalog 예제](/doc?help=examples&item=caemble:experiment/caemble/verified/pixel-monochromatic-response@1.0.2)에서 확인하세요.

흡수 경계조건은 광선을 종료하고, 픽셀 Output은 그 검출 직전의 광학적 전력을 누적합니다. Output을 추가하거나 픽셀 수·관측 두께·`maxPaths`를 바꿔도 광선의 물리적 동작은 바뀌지 않습니다. `maxPaths: 0`은 경로 미저장이며 수치 기록은 계속 생성합니다. 여러 Output이 같은 면을 관측해도 전체 detected power를 중복 집계하지 않습니다.

픽셀 Output은 잘리지 않은 직사각형 Box 한 면 전체를 지원합니다. 관측 Box는 같은 Geometry 정의에서 만들고 z 셀 중심을 수광면에 맞춥니다. 관측 Box 자체는 충돌 그룹에서 제외하세요. 이동·회전·픽셀 수·피치는 한 정의에서 공유하고, 유효 크기는 픽셀 수×피치로 계산합니다. 곡면·부분 영역·Boolean 절삭 면은 이 Output으로 관측할 수 없습니다. 기존 흡수 검출면은 계속 일반 표면에 사용할 수 있습니다.

픽셀 값의 sampling은 표면 셀 적분입니다. 단위는 W이며 W/m², 체적 평균이나 광선 개수가 아닙니다. 공간 셀을 **합산**하면 총 검출 전력이 됩니다. 평균은 픽셀당 평균 전력으로 다른 연산입니다. 내부 경계의 hit는 높은 인덱스 픽셀에, 양쪽 최외곽 경계는 끝 픽셀에 포함하고 실제 영역 밖 hit는 버립니다. 저장 좌표는 Box local `[0,size]`의 픽셀 중심이며 Viewer에서 x/y를 u/v로 읽습니다.

입력 전력 Output은 같은 호출의 모든 광원 전력을 파장별로 합산합니다. 관측 Box는 기록 좌표만 제공하며 광원을 공간 필터링하지 않습니다. 도달 효율은 기록된 픽셀 합을 같은 파장의 기록된 입력 전력으로 나눕니다. 현재 편집 중인 source에서 분모를 복원하지 않습니다.

frequency축은 실제 입력 파장별 기여이며 연속 스펙트럼 밀도 W/Hz·W/nm나 센서의 보정된 분광 채널이 아닙니다. Viewer의 Hz/nm 표시는 같은 데이터의 좌표 변환입니다. 프로파일에서 나머지 공간 축을 sum으로 집계하고 파장을 선택하세요. 합산 방향과 W 단위를 확인하며 원시 신호를 smoothing하지 않습니다.

기본 예제는 중앙 위치의 단색 조건입니다. 특성화할 때는 예제에서 별도 source를 만들고 `sensor.ts`의 `inputWavelengths`를 세 파장으로 고정합니다. `slitPosition` 범위를 넓힌 뒤 세 위치를 각각 Candidate로 **미리 빌드**하고 기존 실행 기능을 사용하세요. 각 Measurement는 그 위치의 세 파장을 frequency축에 기록합니다. 위치를 time·component축에 넣거나 `simulate.py`에서 Task를 추가하지 않습니다. CLI에서 고정 Candidate는 `experiment build <source> --mode candidate --vars <vars.json> --out <artifact>`로 빌드하고 동일 artifact를 `experiment test` 또는 `batch submit`에 사용합니다.

예제 Calculation은 총전력·도달 효율·u/v 합산 프로파일·전력 가중 중심을 제공합니다. 중심은 무신호에서 평가 오류가 되며 0이나 NaN으로 대체하지 않습니다. 국소 파장 샘플링 Calculation은 인접 파장 사이의 `pitch / |Δcentroid/Δλ|`를 계산합니다. 단일 파장, 무신호 또는 거의 영인 분산에서는 평가할 수 없습니다. 다중 피크나 회절 차수 중첩을 하나의 역보정식으로 해석하지 마세요.

nm/pixel은 기하광학적 파장 샘플링 간격이며 최종 분광 분해능이 아닙니다. QE·전자 잡음·회절 PSF·공차·보정은 포함하지 않습니다. 대물광학계나 물체 공간의 성능을 검증한 결과도 아닙니다. [Ansys 분광기 구현 문서](https://optics.ansys.com/hc/en-us/articles/42661705172243-How-to-build-a-spectrometer-implementation)는 픽셀 크기와 회절의 영향을 함께 검토합니다.

Prediction에서는 픽셀 수와 입력 파장 표본을 고정한 채 광학계 설계 변수만 바꾸세요. 단색 기본 실행과 다파장 특성화 결과는 같은 학습 묶음에 섞지 않습니다. 저장 결과와 현재 Geometry가 다르면 기존 Viewer가 overlay를 차단합니다. Calculation과 Prediction은 광선 경로 없이 수치 Record만 사용합니다.

[Catalog 예제에서 Folded Ray-Tracing Bench의 source와 현재 Solver 계약 확인하기](/doc?help=examples)

### 회절격자 Spectrometer

`ray-tracing 5.0.0`의 `ray.diffraction-grating`은 평면 하나에서 반사·투과 차수를 함께 생성합니다. `spacing`, world 좌표의 `grooveDirection`, 중복 없는 정수 `orders`를 지정하고, 같은 길이의 `reflectedEfficiencies`와 `transmittedEfficiencies` 배열을 모두 제공합니다. 반사만 필요하면 투과 배열 전체를 0으로, 투과만 필요하면 반사 배열 전체를 0으로 지정하세요. 두 효율 배열의 모든 값은 0~1이며 합은 1 이하여야 합니다. 이전 `ray.reflection-grating`과 `efficiencies` 문법은 제거되었습니다. 저장된 사용자 Experiment는 자동 변환하지 않으므로 새 문법으로 수정하고 빌드하세요.

양의 차수는 `grooveDirection × authored outward normal`을 따릅니다. 접선 방향은 `(n_i d_in,parallel + m λ₀ / spacing × (grooveDirection × normal)) / n_out`이며, 반사는 입사 매질, 투과는 반대편 Material의 굴절률을 사용합니다. 법선 성분은 반사와 투과의 진행 반공간에 맞춥니다. Material에서 굴절률을 읽으므로 격자에 별도 굴절률을 입력하지 않습니다. 투과 후에는 매질 상태가 바뀌며 기판의 다른 면과 내부에서는 기존 굴절·Fresnel·흡수가 적용됩니다. 방향식은 [Ansys 회절 방향 계산 설명](https://optics.ansys.com/hc/en-us/articles/42661666095891-Simulating-diffraction-efficiency-of-surface-relief-grating-using-the-RCWA-method)을 참고합니다.

효율은 입사 전력에 대한 **절대 비율**입니다. 격자 면에서는 별도 Fresnel 계수를 곱하지 않으며, 미지정 전력과 전파 불가능한 차수의 전력은 손실입니다. 역방향 입사에도 같은 지정 효율을 사용합니다. 같은 면의 중복 격자 및 detector·박막·표면 산란과의 중복 적용은 거부합니다.

[Transmission Grating Response](/doc?help=examples&item=caemble:experiment/caemble/verified/transmission-grating-response@1.0.0)는 유한한 슬릿 영역의 평행 입력, 투명 기판, 반사측·투과측 픽셀 검출기를 포함합니다. 기본 입력은 450/550/650 nm이며 +1차의 반사 효율은 0.1, 투과 효율은 0.7입니다. 한 Measurement에 `reflectedPower`, `transmittedPower`, `launchedPower`를 기록하며 Calculation으로 양쪽 총전력·도달 효율과 투과측 파장별 u 중심을 계산합니다. 중심은 기록된 Box local 좌표를 사용합니다. Viewer에서 두 검출기의 입력 파장별 응답과 양쪽 광로를 확인하세요.

이 모델은 지정 효율을 사용하는 기하광학 모델입니다. 효율의 파장·입사각·편광 의존성, RCWA, 체적 홀로그래픽 격자와 회절 PSF는 계산하지 않습니다. 픽셀 신호나 선폭을 최종 분광 분해능으로 해석하지 마세요.

광학 배치는 [Newport의 Czerny–Turner 설명](https://www.newport.com/n/grating-monochromator-design)을 참고합니다. 첫 오목거울이 슬릿의 빛을 모아 평면 격자에 보내고, 두 번째 오목거울이 분산된 빛을 검출기에 모읍니다.

Examples에서 **Czerny–Turner Spectrometer**를 열면 슬릿, 두 오목거울, 평면 반사격자와 검출기의 배치를 볼 수 있습니다. Vars의 각 범위 중앙값이 기준 설계입니다. 슬릿 폭, 격자 밀도·회전각, 초점거리와 검출기 이동을 바꾼 뒤 **Save & Run**으로 현재 조건을 실행하세요. 격자를 회전해도 검출기는 자동으로 따라가지 않습니다.

반사격자는 지정한 여러 회절 차수로 광선을 나눕니다. 양의 차수 방향은 월드 좌표의 홈 방향과 형상 바깥쪽 법선의 외적으로 정합니다. 효율은 입사 파워에 대한 비율이며 합은 1 이하여야 합니다. 전파할 수 없는 차수와 남은 파워는 손실로 처리하고 다른 차수로 재분배하지 않습니다.

검출기는 기준 파장의 +1차 광로에 배치되어 있습니다. 3D Viewer에서 파장별 광선과 diffraction 이벤트, Box Grid의 fluence rate와 radiant flux density를 확인하세요. 거울은 정점 곡률을 초점거리에 맞춘 편평 타원면 오목거울입니다. 격자의 효율과 거울 광학 상수는 교육용 지정값이며, 홈 형상에 따른 편광·파장별 효율, 위상 지연과 회절 한계 분해능은 계산하지 않습니다.

[Catalog 예제에서 Spectrometer의 source와 현재 Solver 계약 확인하기](/doc?help=examples)
