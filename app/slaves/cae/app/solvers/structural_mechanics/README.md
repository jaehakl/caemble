# CSG 구조해석 Solver

CSG 형상과 물리 조건에서 Solver가 체적 메쉬를 생성하는 ABI 3 구현이다.
공개 입력·출력과 실행 가능한 예제는 정본 SQLite Catalog에서 조회한다.
수기 절점·요소 입력으로 연결되는 공개 경로는 없다.

- [구현·물리 의미·검증](../../../../../../docs/development/structural-mechanics.md)
- [Solver 개발 계약](../../../../../../docs/development/solver-development.md)
- [작성·빌드·로컬 실행](../../../../../../docs/authoring/solver.md)
- [메쉬를 보존하는 기록과 Viewer](../../../../../../docs/manual/program/program-domain-recording.md)

직접 배열을 쓰는 내부 요소 수치 회귀는 `tests/structural_fixture.py`와
`tests/test_structural_*`에서 유지한다. 생산 진입점은 CSG 형상 전처리만 사용한다.
