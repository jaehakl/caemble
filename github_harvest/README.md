# GitHub CAE / Simulation DB Harvester (DB-managed keywords)

이 프로젝트는 GitHub에서 “시뮬레이션/CAE/EM/반도체/나노/광학(ray tracing 포함)” 관련 오픈소스 저장소를 최대한 넓게 수집해, SQLite 데이터베이스로 축적하는 수집기입니다.

핵심 컨셉은 다음 3가지입니다.

1) 키워드 사전(도메인/방법/의도/병렬 등)을 코드에 박아두지 않고 DB 테이블에서 관리합니다.  
2) DB 키워드로부터 랜덤 조합 쿼리를 만들고, 같은 쿼리는 한 번만 실행하도록 캐싱합니다.  
3) 어떤 쿼리로 발견된 repo는 그 쿼리의 속성(tags)을 가진 것으로 간주하고 repo 레코드에 누적 기록합니다.

그리고 “사전 기반 방식의 누락”을 줄이기 위해,

4) 수집된 repo의 description/topics에서 새 키워드를 자동 추출하여 후보로 쌓고,  
5) 후보를 사람이 승인(promote)해 active 키워드로 편입하면서 점진적으로 사전을 확장합니다.

---

## 요구사항

- Python 3.10+
- `requests` 설치
  - `pip install requests`
- GitHub Token (권장)
  - 인증 없이도 동작하지만 rate limit 때문에 실사용이 어렵습니다.

환경변수 설정:
- macOS/Linux:
  - `export GITHUB_TOKEN="ghp_..."`
- Windows PowerShell:
  - `setx GITHUB_TOKEN "ghp_..."`

---

## 데이터 모델(요약)

SQLite DB 파일 하나에 아래 테이블이 생성됩니다.

- `keywords`: 현재 “사용 중(active)” 키워드 사전  
  - category: domain/method/intent/hpc 등
  - term: 키워드 문자열
  - weight: 랜덤 조합 시 샘플링 가중치
  - status: active/paused

- `queries`: 실행된(또는 예정) 쿼리
  - query: 실제 GitHub Search 쿼리 문자열 (UNIQUE)
  - recipe_json: 어떤 키워드 조합으로 만들어졌는지
  - executed_at: 실행 완료 시각(있으면 캐시되어 재실행 안 함)

- `repos`: 발견된 저장소 (PK = `full_name` = owner/name)
  - merged_tags_json: 쿼리에서 유도된 태그 누적
  - topics_json: repo details API에서 가져온 topics

- `repo_hits`: 어떤 쿼리에서 어떤 repo가 나왔는지의 provenance

- `keyword_candidates`: 자동 추출된 후보 키워드
  - term: 후보 키워드
  - score/occurrences: 출현 강도
  - sources_json: 어떤 repo의 어떤 필드에서 나왔는지 근거

---

## 빠른 시작

### 1) DB 초기화 + 시드 키워드 삽입
```bash
python github_cae_db_harvester.py --db cae.sqlite init
````

### 2) 수집 실행(랜덤 쿼리)

```bash
python github_cae_db_harvester.py --db cae.sqlite harvest --steps 200 --per_page 50 --pages_per_query 2
```

* `--steps`: 서로 다른 쿼리 실행 횟수(= 쿼리 캐시를 쌓는 방식으로 커버리지 확대)
* `--pages_per_query`: 한 쿼리에서 몇 페이지까지 긁을지 (깊게 파기보다는 쿼리 다양화가 보통 더 유리)

### 3) repo topics 채우기(권장)

GitHub Search 결과에는 topics가 항상 포함되지 않아서, repo details API로 topics를 채워주면 후보 키워드 추출 품질이 올라갑니다.

```bash
python github_cae_db_harvester.py --db cae.sqlite enrich --limit 300
```

### 4) 후보 키워드 추출

```bash
python github_cae_db_harvester.py --db cae.sqlite extract --limit_repos 3000 --top_n 800
```

* description/topics에서 토큰을 뽑아 `keyword_candidates`에 쌓습니다.
* topics에서 나온 단어는 description보다 높은 점수로 반영합니다.

### 5) 후보 키워드 검토 후 승격(promote)

예를 들어 후보 CSV를 뽑아 보고:

```bash
python github_cae_db_harvester.py --db cae.sqlite export candidates --status pending --out candidates_pending.csv
```

마음에 드는 후보를 active 키워드로 승격합니다.

```bash
python github_cae_db_harvester.py --db cae.sqlite promote "radiative-transfer" --category domain --weight 0.5 --source manual
python github_cae_db_harvester.py --db cae.sqlite promote "pic" --category domain --weight 0.4
python github_cae_db_harvester.py --db cae.sqlite promote "particle-in-cell" --category domain --weight 0.4
```

배치 승격도 가능합니다.

```bash
python github_cae_db_harvester.py --db cae.sqlite promote --csv candidates_pending.csv
```

`promote --csv` 입력 CSV 양식:

- 필수 컬럼
  - `term`
- 조건부 필수 컬럼
  - `category` 또는 `suggested_category` 중 하나
  - 둘 다 없으면 CLI의 `--category` 값을 fallback으로 사용
- 선택 컬럼
  - `weight` (행별 가중치, 없으면 `--weight` 사용)
  - `source` (행별 source, 없으면 `--source` 사용)

예시 CSV:

```csv
term,category,weight,source
radiative-transfer,domain,0.5,manual
particle-in-cell,domain,0.4,auto
petsc,hpc,0.6,manual
```

`export candidates` 결과 CSV를 그대로 쓸 때는 `suggested_category`를 사용합니다:

```bash
python github_cae_db_harvester.py --db cae.sqlite promote --csv candidates_pending.csv --weight 0.4 --source auto
```

승격된 키워드는 다음 harvest 라운드부터 쿼리 생성에 반영됩니다.

---

## CSV Export

### repos 내보내기

```bash
python github_cae_db_harvester.py --db cae.sqlite export repos --out repos.csv
```

`repos.csv`에는 아래가 포함됩니다:

* full_name, html_url
* merged_tags_json (쿼리에서 유도된 태그 누적)
* stars, forks, license, language, updated_at
* topics_json

### repos.csv 기준 README 수집

GitHub API로 `repos.csv`의 각 `full_name`(또는 `html_url`)에 대해 README를 받아 파일로 저장할 수 있습니다.

```bash
python github_cae_db_harvester.py fetch-readmes --csv repos.csv --out-dir readme_files
```

- 출력 파일명 규칙: `owner/repo` -> `owner__repo.md`
  - Windows 파일명에서 `/`를 쓸 수 없어 `__`로 치환합니다.
- 입력 CSV 컬럼
  - `full_name` 또는 `html_url` 중 하나는 있어야 함
- 추가 옵션
  - `--overwrite`: 기존 파일 덮어쓰기
  - `--limit N`: 최대 N개 repo만 시도

### candidates 내보내기

```bash
python github_cae_db_harvester.py --db cae.sqlite export candidates --status pending --out candidates.csv --limit 5000
```

---

## 운용 팁(품질/커버리지)

* “완전 자동 승격”은 잡음이 섞이기 쉬워서, 후보를 CSV로 보고 사람이 일부만 승격하는 방식이 보통 가장 좋습니다.
* 수집이 일정 수준 쌓이면 `keywords.weight`를 조정해 “유의미한 랜덤”으로 바꿀 수 있습니다.

  * 예: 관심 도메인(EM/반도체/나노/광학)에 weight를 조금 높이고, 그래도 다른 domain 키워드가 꾸준히 뽑히도록 유지
* GitHub Search는 구조적으로 1000개 결과 이상에서는 제약이 있으므로,

  * 한 쿼리를 깊게 파기보다는 쿼리를 많이 만들어 분산 수집하는 전략이 유리합니다.
* ray tracing은 `domain`과 `method`에 모두 들어가도록 시드가 구성되어 있습니다.

  * “rendering/graphics” 키워드도 일부 섞여 있어 광학 설계/조명/렌더링 경계에 있는 프로젝트도 포착 가능성을 올립니다.

---

## 다음 확장

* README를 실제로 내려받아(또는 첫 N KB만) 키워드 후보 추출 원천을 늘리기
* topics 뿐 아니라 `GET /repos/{owner}/{repo}/languages` 등을 수집해 기능별 필터링 강화
* “신규 레포 발견 효율”을 기준으로 키워드 weight를 자동 조정하는 bandit 방식
* 제외 필터(렌더링 엔진 중 CAE/광학 시뮬레이션과 거리가 먼 순수 그래픽스 프로젝트를 후처리로 제외) 추가
