# Non-sequential Ray Tracing

`ray-tracing@1.0.0`은 미리 정한 표면 순서를 따르지 않고, 광선이 기하와 만나는 순서대로 반사·굴절·산란·흡수를 추적하는 non-sequential solver입니다. 다중 반사, stray light, 바플과 혼탁 매질을 포함한 광학계에 사용하세요.

### 광원과 산란

- 광원은 point, area, directional, Lambertian 형식을 지원합니다. 모든 광원의 emitter locator geometry 또는 surface는 `ray.domain` group에서 제외하고, 실제 방출 위치도 모든 collision solid 바깥에 두세요. 각 광원 initialization call은 하나의 이산 wavelength line을 나타내므로, 여러 call을 나란히 추가해 다중 파장 광원을 구성합니다.
- 편광은 광원의 4성분 Stokes vector로 주입합니다. 표면의 ABg 및 Lambertian scatter와 체적의 Henyey–Greenstein(HG) scatter를 사용하며, 산란된 광선은 depolarized 상태로 계속 추적됩니다.
- `ray.domain` collision solid는 올바르게 중첩할 수 있지만 서로 부분적으로 겹치면 안 됩니다. 매질 경계의 진입·이탈 순서가 모호한 overlap은 실행을 거부합니다.

### Shell layer의 적응형 박막 처리

`<coating>` element를 따로 만들지 마세요. Solver가 canonical `<shell>`의 **각 layer에 대한 물리적 두께**를 판정합니다. 두께가 엄격히 `50 µm` 미만인 layer는 transfer-matrix method(TMM) 박막으로 적응형 처리하고, 인접한 박막 layer는 하나의 multilayer stack으로 계산합니다. 정확히 `50 µm`인 layer와 그보다 두꺼운 layer는 일반 광선–표면 collision으로 추적됩니다.

박막과 체적에 사용할 광학 모델과 계수는 `material.tsx`에 명시합니다. Solver의 지원 모델과 입력 규격은 [Model Catalog](/?help=materials)에서 확인하세요. 주파수 표본 모델은 Hz로 엄격히 증가하는 표본열을 받아 광원 파장의 `frequency = c / wavelength`에서 각 성분을 선형 보간합니다. 표본 범위 밖에서는 가장 가까운 끝점 값을 사용합니다. 복소 굴절률 모델의 부호 및 감쇠 해석은 모델의 관례를 따릅니다.

### Detector와 ray path

Detector surface에서 irradiance, detected power, source 대비 efficiency를 기록할 수 있습니다. 경로를 표시하려면 Task outputs에 `ray.paths`를 요청하고 `recordedData`에 `{ task, output }`으로 그 key를 참조하세요. 결과 이름은 자유롭게 정하며 여러 ray 결과를 함께 기록할 수 있습니다. `sim.record`에는 해당 output artifact를 전달하고 기록 후 `sim.release`로 해제합니다. Catalog의 polyline 계약이 경로 구성 데이터와 표시 방식을 결정합니다. 다른 Solver의 mesh field와도 같은 Viewer에서 선택하거나 Overlay할 수 있습니다.

[Folded Ray-Tracing Bench의 검증된 source, detector와 ray-path 계약 열기](/?help=examples&item=caemble:experiment/caemble/verified/folded-ray-tracing@4.0.0)

### 회절격자 Spectrometer

광학 배치는 [Newport의 Czerny–Turner 설명](https://www.newport.com/n/grating-monochromator-design)을 참고합니다. 첫 오목거울이 슬릿의 빛을 모아 평면 격자에 보내고, 두 번째 오목거울이 분산된 빛을 검출기에 모읍니다.

Examples에서 **Czerny–Turner Spectrometer**를 열면 슬릿, 두 오목거울, 평면 반사격자와 검출기의 배치를 볼 수 있습니다. Vars의 각 범위 중앙값이 기준 설계입니다. 슬릿 폭, 격자 밀도·회전각, 초점거리와 검출기 이동을 바꾼 뒤 **Save & Run**으로 현재 조건을 실행하세요. 격자를 회전해도 검출기는 자동으로 따라가지 않습니다.

`ray-tracing@1.0.0`의 반사격자는 지정한 여러 회절 차수로 광선을 나눕니다. 양의 차수 방향은 월드 좌표의 홈 방향과 형상 바깥쪽 법선의 외적으로 정합니다. 효율은 입사 파워에 대한 비율이며 합은 1 이하여야 합니다. 전파할 수 없는 차수와 남은 파워는 손실로 처리하고 다른 차수로 재분배하지 않습니다.

검출기는 기준 파장의 +1차 광로에 배치되어 있습니다. 3D Viewer에서 파장별 광선과 diffraction 이벤트를 확인하고 검출기 조도, 검출 파워, 효율을 함께 보세요. 거울은 정점 곡률을 초점거리에 맞춘 편평 타원면 오목거울입니다. 격자의 효율과 거울 광학 상수는 교육용 지정값이며, 홈 형상에 따른 편광·파장별 효율, 위상 지연과 회절 한계 분해능은 계산하지 않습니다.

[Spectrometer 예제의 source와 Solver 계약 열기](/?help=examples&item=caemble:experiment/caemble/verified/czerny-turner-spectrometer@4.0.0)
