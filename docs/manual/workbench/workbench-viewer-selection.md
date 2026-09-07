# 3D Viewer에서 Geometry와 Surface ID 확인

3D Viewer의 **Off / Geometry / Surface** 선택 모드로 렌더링된 대상의 실제 Scene 전역 경로를 확인할 수 있습니다. 최초 모드는 **Off**이며 이 상태에서는 기존 카메라 회전·이동만 동작합니다.

- **Geometry** 모드에서 클릭하면 가장 가까운 part 전체가 강조되고 `starter.body` 같은 geometry 전역 경로가 표시됩니다.
- **Surface** 모드에서 클릭하면 해당 면만 강조되고 `starter.body/surface/1` 같은 surface 전역 경로가 표시됩니다.
- 선택 카드의 복사 버튼으로 Solver group에 사용할 경로를 복사할 수 있습니다. Focus 버튼은 해당 geometry 또는 surface에 현재 카메라 방향을 유지한 채 화면을 맞춥니다. 선택된 경로는 Source에서 자동으로 확인되며 정확한 문자열 사용처가 있을 때만 Source 찾기 버튼이 활성화됩니다. 한 곳이면 바로 이동하고 여러 곳이면 결과 목록을 표시합니다. 빈 공간을 클릭하거나 Clear 버튼을 누르면 Viewer 선택이 해제됩니다.
- 마우스를 움직인 동작은 클릭이 아니라 카메라 조작으로 처리하므로 드래그 도중 대상이 바뀌지 않습니다.

Source 편집기에서 `geometryGroup`·`surfaceGroup`의 전역 경로 문자열에 커서를 두면 정확한 대상이 Viewer에서 강조됩니다. 정적인 JSX `id="body"`에 커서를 두면 해당 local segment가 만든 현재 Scene의 모든 실행 인스턴스를 강조하고 각각의 전역 경로를 보여 줍니다.

계산식이나 expression이 포함된 template ID는 Source에 하나의 구체적인 실행 경로가 없으므로 코드에서 자동 역매칭하지 않습니다. 이 경우 Viewer에서 인스턴스를 직접 선택해 확정된 전역 경로를 확인하세요. Viewer 선택만으로는 코드 탭이나 커서를 이동시키지 않으며 Source 찾기 버튼을 누른 경우에만 검색 결과로 이동합니다. 선택은 Draft나 URL에 저장되지 않습니다.
