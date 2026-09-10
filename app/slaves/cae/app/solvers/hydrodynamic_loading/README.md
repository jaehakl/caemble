# 물의 운동을 구조물의 힘과 질량으로 바꾸기

`entry.py`는 ABI 연결, `domain.py`는 입력 정리, `formulation.py`는 수치 계산,
`outputs.py`는 결과 포장이다. 구조 Solver의 내부 모델을 import하지 않고,
공개 interface·motion artifact만 읽는다. 실행 입력의 정식 선언은 Catalog에 있다.

Airy 파랑은 수면 진폭과 주기로 물 입자의 속도·가속도를 구하는 선형 이론이다.
먼저 `ω² = g k tanh(k h)`를 풀어 파수 k를 구한다. 이 식은 수심 h의 영향을
반영한다. 깊이가 깊어질수록 파랑의 영향이 약해지고 해저에서 수직 속도는 0이 된다.
여러 파 성분은 더해지며, 조류 속도는 별도로 더한다. 파랑·조류의 Doppler 상호작용은 없다.

원통 부재의 물에 잠긴 기준 구간을 세 Gauss 점으로 적분한다. 부재 축 방향을
제외한 상대 속도 `u_rel = P (u_water − v_body)`가 원통의 횡방향 항력을 만든다.
여기서 `P = I − t tᵀ`는 단위 부재축 t에 수직인 성분만 남기는 행렬이다.

반환하는 외력과 부가질량은 다음처럼 분리된다.

```
분포 외력 = ρ (Cp + Ca) A P a_water
          + ½ ρ Cd D |u_rel| u_rel
          + 부력
부가질량 = ρ Ca A P
구조 방정식: (M_structure + M_added) a_body + 내부력 = 외력
```

부가질량은 양의 대칭 3×3 절점 tensor로 보낸다. 구조 해석은 이것을 질량행렬에
한 번 더한다. 외력에 `−M_added a_body`를 다시 넣으면 동일한 물의 관성을 두 번
계산하므로 넣지 않는다. 서로 다른 물리 Solver의 힘·모멘트는 더할 수 있지만,
동일한 hydro 결과의 부가질량을 반복해서 누적하면 안 된다.

분포 하중을 선형 절점 형상함수로 나누므로 전체 힘과 기준 위치에 대한 모멘트가
보존된다. 부력은 입력 `buoyancyAreas`에 따른 `ρ g A_b`이며, 잠긴 체적의
선형 근사다. 침수·밀폐 상태에 맞는 유효 면적을 모델 작성자가 선택해야 한다.

현재 물에 잠긴 길이·부재 축·파랑 평가 위치는 기준 형상을 사용한다. 움직임은
상대 항력에 반영된다. 수면 변동에 따른 젖음/마름, slamming, 회절, 방사 감쇠,
축방향 유체력과 해저 지반 비선형성은 이 모듈의 범위 밖이다. 이러한 가정이
적합한 고정식 가느다란 부재 모델을 사용한다.

직접 API는 `hydrodynamic_response`, 파랑 API는 `airy_kinematics`다.
`tests/test_wind_physics.py`는 분산 관계, 속도의 시간 미분과 가속도의 일치,
해저 경계조건, 깊은 물에서의 유한한 값, 균일 조류의 해석적 힘·모멘트,
상대 항력, 젖은 길이 절단과 부가질량의 중복 방지를 검사한다.

출처: [OpenFAST HydroDyn 설명](https://openfast.readthedocs.io/en/main/source/user/hydrodyn/index.html),
[Morison 가속도 항의 정의](https://openfast.readthedocs.io/en/main/source/user/aerodyn/theory.html#morison-s-equation).
